// W87 — the regen log, moved out of the vault blob.
//
// What these tests hold is the part that cannot be fixed later. The defect being repaired is that a
// record carried megabytes of append-only evidence through every unrelated save until one blob
// reached 5,163,393 bytes and /api/vault/{id} refused it, so the whole point of the relocation is
// that an event is written to its own segment EXACTLY ONCE and then leaves the record. Two things
// make that non-obvious, and each has a test below:
//
//   - The live vault is reassigned by callers that do not go through the save seam
//     (src/App.svelte's createVaultPrincipals and the conflict resolver both assign `vault = v`
//     AFTER their save resolves), so stripping the object the save was handed is not enough. What
//     makes it safe is `relocated`, a module-level WeakSet of events already written.
//   - The write comes FIRST and the record is stripped only on success, so a failed segment write
//     costs a save that was going to fail anyway rather than the evidence.
//
// `write` is injected for both, so neither needs a network. The last two blocks drive the real
// transports instead — localStorage in dev, /api/regen-log in the deployed build.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateDEK, encryptVaultV2 } from "@tinytars/vault/crypto";
import { bytesToB64 } from "@tinytars/vault/base64";
import {
  takeRegenLog,
  dropRelocated,
  relocateRegenLog,
  recordRegenEvents,
  loadRegenLog,
} from "../../src/lib/regen-log-store";
import type { Client, RegenEvent, Vault } from "../../src/lib/types";

const ev = (at: string, node = "nodeA"): RegenEvent => ({
  at,
  node,
  triggeredBy: "refresh",
  sections: ["noteResults"],
  before: { noteResults: "was" },
  after: { noteResults: "is" },
});

const client = (regenLog?: RegenEvent[]): Client =>
  ({ displayName: "p", dob: "1980-01-01", gender: "male", watchlist: [], results: [], ...(regenLog ? { regenLog } : {}) }) as Client;

const vaultOf = (logs: Record<string, RegenEvent[] | undefined>): Vault => ({
  clients: Object.fromEntries(Object.entries(logs).map(([id, log]) => [id, client(log)])),
  rawKeys: { alex: { "a.pdf": "k" } },
});

/** A write that records what it was asked to store, and can be made to refuse one client. */
function recorder(failFor: string[] = []) {
  const calls: { clientId: string; events: RegenEvent[]; dek: CryptoKey }[] = [];
  const write = vi.fn(async (events: RegenEvent[], clientId: string, dek: CryptoKey) => {
    if (failFor.includes(clientId)) throw new Error("segment write refused");
    calls.push({ clientId, events, dek });
    return 1234;
  });
  return { calls, write };
}

let dek: CryptoKey;
let other: CryptoKey;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dek = await generateDEK();
  other = await generateDEK();
  // The store reports a relocation and a failed segment on the console deliberately; silenced here
  // so a suite run is readable, and asserted in "reports a count and a size, never an event".
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
});

describe("takeRegenLog", () => {
  it("removes every client's log and hands back one batch per client that had one", () => {
    const a = [ev("2026-01-01T00:00:00Z")];
    const b = [ev("2026-01-02T00:00:00Z"), ev("2026-01-03T00:00:00Z")];
    const { vault, batches } = takeRegenLog(vaultOf({ alex: a, blair: b, cass: undefined }));

    expect(batches).toEqual([
      { clientId: "alex", events: a },
      { clientId: "blair", events: b },
    ]);
    expect(vault.clients.alex.regenLog).toBeUndefined();
    expect(vault.clients.blair.regenLog).toBeUndefined();
    // Everything stored beside `clients` survives, or the first save after this loses the key ring.
    expect(vault.rawKeys).toEqual({ alex: { "a.pdf": "k" } });
  });

  it("is pure — the vault handed in still carries its log", () => {
    const original = vaultOf({ alex: [ev("2026-01-01T00:00:00Z")] });
    const { vault } = takeRegenLog(original);
    expect(original.clients.alex.regenLog).toHaveLength(1);
    expect(vault).not.toBe(original);
  });

  it("returns the very same vault when no client has a log", () => {
    const original = vaultOf({ alex: undefined, blair: [] });
    expect(takeRegenLog(original).vault).toBe(original);
    expect(takeRegenLog(original).batches).toEqual([]);
  });
});

describe("relocateRegenLog", () => {
  it("writes one segment per client, then hands back the vault to save", async () => {
    const events = [ev("2026-01-01T00:00:00Z")];
    const { calls, write } = recorder();
    const { vault, written, failed } = await relocateRegenLog(vaultOf({ alex: events }), dek, write);

    expect(calls).toEqual([{ clientId: "alex", events, dek }]); // sealed under the vault's own DEK
    expect(write).toHaveBeenCalledTimes(1);
    expect(written).toEqual(events);
    expect(failed).toEqual([]);
    expect(vault.clients.alex.regenLog).toBeUndefined();
  });

  // THE defect this file exists for. App.svelte's createVaultPrincipals and conflict resolver assign
  // the vault they were handed AFTER the save resolves, so the live record can still be carrying a
  // log that is already durable — and every later save would re-write the same megabytes as a new
  // segment, forever. Identity-stripping the saved object cannot fix that; the WeakSet can.
  it("never writes an event a second time, whatever the caller assigns afterwards", async () => {
    const events = [ev("2026-01-01T00:00:00Z")];
    const { calls, write } = recorder();
    const live = vaultOf({ alex: events });

    await relocateRegenLog(live, dek, write);
    // The caller puts the ORIGINAL vault back, log and all, exactly as those two call sites do.
    const second = await relocateRegenLog(live, dek, write);

    expect(calls).toHaveLength(1);
    expect(second.written).toEqual([]);
    expect(second.vault.clients.alex.regenLog).toBeUndefined();
  });

  it("keeps a new event that arrived while the write was in flight", async () => {
    const first = ev("2026-01-01T00:00:00Z");
    const second = ev("2026-01-02T00:00:00Z", "nodeB");
    const { calls, write } = recorder();

    await relocateRegenLog(vaultOf({ alex: [first] }), dek, write);
    // A regen landed during the window: a different object, so it is not covered by the first write.
    await relocateRegenLog(vaultOf({ alex: [first, second] }), dek, write);

    expect(calls.map((c) => c.events)).toEqual([[first], [second]]);
  });

  // The write is first precisely so this case cannot lose the log. A segment failure must also not
  // fail the save: the patient is trying to store their record, and the log is not what they asked
  // to store — so the only consequence is that the evidence stays in the record until next time.
  it("puts the log back in the record when its segment write fails, and does not throw", async () => {
    const events = [ev("2026-01-01T00:00:00Z")];
    const { write } = recorder(["alex"]);
    const { vault, written, failed } = await relocateRegenLog(vaultOf({ alex: events }), dek, write);

    expect(failed).toEqual(["alex"]);
    expect(written).toEqual([]);
    expect(vault.clients.alex.regenLog).toEqual(events);
    expect(vault.rawKeys).toEqual({ alex: { "a.pdf": "k" } });
  });

  it("one client's failure does not cost another client its relocation", async () => {
    const a = [ev("2026-01-01T00:00:00Z")];
    const b = [ev("2026-01-02T00:00:00Z")];
    const { calls, write } = recorder(["alex"]);
    const { vault, failed } = await relocateRegenLog(vaultOf({ alex: a, blair: b }), dek, write);

    expect(calls).toEqual([{ clientId: "blair", events: b, dek }]);
    expect(failed).toEqual(["alex"]);
    expect(vault.clients.alex.regenLog).toEqual(a);
    expect(vault.clients.blair.regenLog).toBeUndefined();
  });

  // The size of one client's log was not knowable before this: the vault blob is never decrypted,
  // and there is no server-side regen telemetry. This line is that measurement, and it is also a
  // line printed in a browser console — so it carries a count and a size and no event content.
  it("reports a count and a size, never an event", async () => {
    const { write } = recorder();
    await relocateRegenLog(vaultOf({ alex: [ev("2026-01-01T00:00:00Z")] }), dek, write);

    const line = info.mock.calls.map((c: unknown[]) => String(c[0])).find((l: string) => l.includes("relocated"))!;
    expect(line).toBe("regen-log: relocated 1 event(s), 1234 bytes, for alex");
    expect(line).not.toContain("noteResults");
  });
});

describe("dropRelocated", () => {
  it("drops what is durable and keeps what is not", async () => {
    const durable = ev("2026-01-01T00:00:00Z");
    const fresh = ev("2026-01-02T00:00:00Z", "nodeB");
    const { write } = recorder();
    await relocateRegenLog(vaultOf({ alex: [durable] }), dek, write);

    const live = dropRelocated(vaultOf({ alex: [durable, fresh], blair: [fresh] }));
    expect(live.clients.alex.regenLog).toEqual([fresh]);
    expect(live.clients.blair.regenLog).toEqual([fresh]);
  });

  it("removes the field entirely once nothing is left, and is otherwise a no-op", async () => {
    const durable = ev("2026-01-01T00:00:00Z");
    const { write } = recorder();
    await relocateRegenLog(vaultOf({ alex: [durable] }), dek, write);

    expect(dropRelocated(vaultOf({ alex: [durable] })).clients.alex).not.toHaveProperty("regenLog");
    const untouched = vaultOf({ alex: [ev("2026-02-01T00:00:00Z")] });
    expect(dropRelocated(untouched)).toBe(untouched);
  });
});

// The dev transport. Not a detail: vite serves the app with no Worker, so this is the path every
// local run and every e2e run takes, and a relocation that only worked against R2 would read as
// working while silently dropping the log on exactly the builds a developer tests with.
describe("segments, through localStorage (DEV)", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true);
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it("every event ever appended comes back, oldest first, across segments", async () => {
    const later = ev("2026-02-01T00:00:00Z", "nodeB");
    const earlier = ev("2026-01-01T00:00:00Z");
    expect(await recordRegenEvents([later], "Alex", dek)).toBeGreaterThan(32);
    await recordRegenEvents([earlier], "Alex", dek);

    // Written under "Alex", read as "alex": the key is normalized, as every other client-keyed store is.
    expect(await loadRegenLog("alex", dek)).toEqual([earlier, later]);
  });

  it("skips a segment sealed under a key it does not hold rather than hiding the rest", async () => {
    await recordRegenEvents([ev("2026-01-01T00:00:00Z")], "alex", other);
    const mine = ev("2026-01-02T00:00:00Z");
    await recordRegenEvents([mine], "alex", dek);
    expect(await loadRegenLog("alex", dek)).toEqual([mine]);
  });

  it("has no log at all for a client that never regenerated", async () => {
    expect(await loadRegenLog("nobody", dek)).toEqual([]);
  });
});

// The deployed transport. No precondition and no etag anywhere here, and that is the design rather
// than an omission: the server mints the key, so there is no object two tabs can race for.
describe("segments, through /api/regen-log (deployed)", () => {
  beforeEach(() => vi.stubEnv("DEV", false));

  it("PUTs one segment per append, with no precondition", async () => {
    const puts: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      puts.push({ url, init: init! });
      return new Response(JSON.stringify({ segment: "2026-01-01T00-00-00-000Z-0a1b2c3d.enc" }), { status: 201 });
    }));

    const bytes = await recordRegenEvents([ev("2026-01-01T00:00:00Z")], "Alex", dek);
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe("/api/regen-log/alex");
    expect(puts[0].init.method).toBe("PUT");
    const sent = new Headers(puts[0].init.headers);
    expect(sent.get("If-Match")).toBeNull();
    expect(sent.get("If-None-Match")).toBeNull();
    expect((puts[0].init.body as Uint8Array).length).toBe(bytes);
  });

  // It has to throw, because that refusal is what relocateRegenLog turns into "keep the log in the
  // record". A swallowed failure here is an event deleted from a record and written nowhere.
  it("throws when the append is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 413 })));
    await expect(recordRegenEvents([ev("2026-01-01T00:00:00Z")], "alex", dek)).rejects.toThrow(/\(413\)/);
  });

  it("lists the segments and then fetches each one", async () => {
    const names = ["2026-01-01T00-00-00-000Z-0a1b2c3d.enc", "2026-02-01T00-00-00-000Z-4e5f6a7b.enc"];
    const later = ev("2026-02-01T00:00:00Z", "nodeB");
    const earlier = ev("2026-01-01T00:00:00Z");
    const sealed = new Map([
      [names[0], await encryptVaultV2({ events: [later] }, dek)],
      [names[1], await encryptVaultV2({ events: [earlier] }, dek)],
    ]);

    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      asked.push(url);
      const wanted = new URL(url, "http://x").searchParams.get("segment");
      if (!wanted) return new Response(JSON.stringify({ segments: names }), { status: 200 });
      return new Response(sealed.get(wanted) as BodyInit, { status: 200 });
    }));

    // Sorted by the event's own timestamp, not by the segment it arrived in.
    expect(await loadRegenLog("alex", dek)).toEqual([earlier, later]);
    expect(asked[0]).toBe("/api/regen-log/alex");
    expect(asked).toHaveLength(3);
  });

  it("reads an empty log for a client the server has no namespace for", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    expect(await loadRegenLog("nobody", dek)).toEqual([]);
  });
});

// Not a behaviour test — a shape one. A segment is ciphertext before it reaches any transport, so a
// mis-wired store cannot put a Finding section on the wire in the clear.
describe("what leaves the browser", () => {
  it("is sealed: the plaintext of an event appears nowhere in a segment", async () => {
    const event = ev("2026-01-01T00:00:00Z");
    const blob = await encryptVaultV2({ events: [event] }, dek);
    expect([...blob.slice(0, 3)]).toEqual([0x48, 0x44, 0x31]); // HD1 — what the route checks for
    expect(bytesToB64(blob)).not.toContain("noteResults");
    expect(new TextDecoder().decode(blob)).not.toContain("noteResults");
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { namespacePairs, rekeyClient } from "../../scripts/commands/rekey";
import { renameClientKey } from "../../scripts/commands/rekey-vault";
import { classifyKey, type KeyClass } from "../../scripts/vault-sync";
import type { Vault } from "../../src/lib/types";

// G1 — a rekey that misses a namespace does not fail: it succeeds and strands that namespace's
// objects under an id nothing resolves. So the coverage below is the assertion that matters.

describe("namespacePairs", () => {
  it("maps every client-scoped key shape from the old id to the new", () => {
    expect(namespacePairs("dev", "Alex", "0b8c")).toEqual([
      ["dev/data-alex.enc", "dev/data-0b8c.enc"],
      ["dev/chat-alex.enc", "dev/chat-0b8c.enc"],
      ["dev/regen-log/alex/", "dev/regen-log/0b8c/"],
      ["dev/raw/alex/", "dev/raw/0b8c/"],
      ["dev/text/alex/", "dev/text/0b8c/"],
      ["dev/processed/alex/", "dev/processed/0b8c/"],
    ]);
  });

  // The drift guard. `logs/` is the one class R2 holds that is not client-scoped, so it is the only
  // legitimate omission; anything else new in classifyKey must be moved by a rekey too.
  it("covers every client-scoped class classifyKey knows about", () => {
    // A directory prefix needs a filename to be a key; the two exact keys already are one.
    const sample = (from: string) => (from.endsWith("/") ? `${from}f.json` : from);
    const covered = new Set(namespacePairs("dev", "old", "new").map(([from]) => classifyKey("dev", sample(from))));
    expect(covered.has(null)).toBe(false);

    const source = readFileSync(resolve(__dirname, "../../scripts/vault-sync.ts"), "utf8");
    const declared = source.match(/export type KeyClass =([^;]+);/)?.[1] ?? "";
    const classes = [...declared.matchAll(/"(\w+)"/g)].map((m) => m[1] as KeyClass);
    expect(classes.length).toBeGreaterThan(1); // the regex found the union, not an empty string

    expect(classes.filter((c) => c !== "logs" && !covered.has(c))).toEqual([]);
  });
});

describe("rekeyClient refuses a no-op", () => {
  it("rejects when old and new differ only by case, before touching R2", async () => {
    await expect(rekeyClient("Alex", "alex", "dev")).rejects.toThrow(/old and new id are the same/);
  });
});

// The companion half: --rekey-client moves R2 keys, --rekey-vault-client moves the clients map
// inside the ciphertext. Doing only the first is what 404'd every /api/raw/... on dev.
describe("renameClientKey", () => {
  const vault = () =>
    ({
      clients: {
        Alex: { displayName: "Alex", dob: "1980-01-01", gender: "male", watchlist: [], results: [{ id: "r1" }] },
        Blair: { displayName: "Blair", dob: "1982-02-02", gender: "female", watchlist: [], results: [] },
      },
    }) as unknown as Vault;

  it("renames the key, keeps the client object identical, and leaves the others alone", () => {
    const out = renameClientKey(vault(), "Alex", "834bc60d");
    expect(Object.keys(out.clients)).toEqual(["834bc60d", "Blair"]); // order preserved
    expect(out.clients["834bc60d"]).toEqual(vault().clients.Alex);
    expect(out.clients.Blair).toEqual(vault().clients.Blair);
  });

  it("does not mutate the vault it was given", () => {
    const v = vault();
    renameClientKey(v, "Alex", "834bc60d");
    expect(Object.keys(v.clients)).toEqual(["Alex", "Blair"]);
  });

  it("refuses when the old key is absent, naming what the vault actually holds", () => {
    expect(() => renameClientKey(vault(), "alex", "834bc60d")).toThrow(/"Alex", "Blair"/);
  });

  it("refuses to merge into an existing client rather than dropping its results", () => {
    expect(() => renameClientKey(vault(), "Alex", "Blair")).toThrow(/refusing to merge/);
  });
});

// W71 — the same G1 failure as above, one directory away, and it had already happened twice when
// this was written: `scripts/vault-rekey.ts` rotated the DEK, re-encrypted the vault to a new object,
// re-wrapped the new DEK to every principal and DELETEd the old envelopes — and never walked
// `chat-`. The rotation reported success. Seven chat histories across dev and prod were left sealed
// under a DEK that no longer exists anywhere, and the accounts holding them could not save again.
//
// What makes the fix's ORDERING the thing worth pinning is that a chat blob is addressed by its
// client id and nothing in D1 points at it, so unlike the vault it cannot be written to a new key
// and repointed. Both in-place orderings lose data: re-seal before the commit and a crash leaves
// chat under the new DEK while the envelopes still hold the old one; re-seal after it and a crash
// leaves chat under a DEK nothing references. So the re-seal goes to a STAGING prefix before the
// commit, and the promotion onto the live keys happens after the repoint is proved — at which point
// it is a pure object copy that needs no key at all.
//
// Asserted against the source because every step of that path is an authenticated Cloudflare API
// call, which is also why a reordering would not fail anything else here. Same technique as the
// drift guard above, which reads vault-sync.ts.
describe("a DEK rotation covers chat, in the one order that cannot lose it", () => {
  const SOURCE = readFileSync(resolve(__dirname, "../../scripts/vault-rekey.ts"), "utf8");
  const at = (needle: string): number => {
    const i = SOURCE.indexOf(needle);
    expect(i, `vault-rekey.ts no longer contains ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it("re-seals chat to staging BEFORE the D1 transaction", () => {
    expect(at("await resealChatToStaging(")).toBeLessThan(at("await d1(statements.join("));
  });

  it("promotes onto the live chat- keys only AFTER the repoint is proved from D1", () => {
    expect(at("await promoteChatFromStaging(")).toBeGreaterThan(at("if (after[0]?.r2_key !== newR2Key)"));
  });

  it("stages under a prefix the orphan sweep cannot reach", () => {
    // orphan-sweep.ts lists `${store}/chat-` and deletes what it cannot resolve in D1 — which every
    // staged object is by construction, being named for a vault blob id rather than a client.
    expect(SOURCE).toContain("/rekey-chat/");
    expect(SOURCE).not.toContain("/chat-rekey/");
  });

  it("reads out staging residue from an earlier interrupted run", () => {
    // Residue is the only trace a crashed rotation leaves, and it is ambiguous once a second
    // rotation runs, so it is printed before this run's first write rather than after its last.
    expect(at("await reportChatStagingResidue(")).toBeLessThan(at("await rekeyOne(a, store)"));
  });
});

// W87 — and the same failure one namespace later. `chat-` was the only namespace sealed under the
// DEK directly until the regen log moved out of the vault blob, so a rotation that walks chat and
// not `regen-log/` leaves every segment sealed under a DEK that no longer exists. That is softer
// than the chat case — the log has no reader, so nothing breaks loudly — and softer is worse: the
// evidence would be silently unreadable and nobody would find out until somebody tried to read a
// year of it.
//
// The ordering is pinned for the reason above and not because it is likely to be reordered: a
// segment is addressed by its client id with nothing in D1 pointing at it, exactly as a chat blob
// is, so both in-place orderings lose it and staging-then-promote is the only safe one. The four
// assertions deliberately mirror the four above — the two passes are separate functions, and what
// holds them in step is this file asserting the same order of both.
describe("a DEK rotation covers the regen log, in the same order", () => {
  const SOURCE = readFileSync(resolve(__dirname, "../../scripts/vault-rekey.ts"), "utf8");
  const at = (needle: string): number => {
    const i = SOURCE.indexOf(needle);
    expect(i, `vault-rekey.ts no longer contains ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it("re-seals every segment to staging BEFORE the D1 transaction", () => {
    expect(at("await resealRegenLogToStaging(")).toBeLessThan(at("await d1(statements.join("));
  });

  it("promotes onto the live regen-log/ keys only AFTER the repoint is proved from D1", () => {
    expect(at("await promoteRegenLogFromStaging(")).toBeGreaterThan(at("if (after[0]?.r2_key !== newR2Key)"));
  });

  it("stages under a prefix the orphan sweep cannot reach", () => {
    // orphan-sweep.ts lists `${store}/regen-log/` and deletes what it cannot resolve in D1, which
    // every staged object is by construction, being named for a vault blob id rather than a client.
    expect(SOURCE).toContain("/rekey-regen-log/");
    expect(SOURCE).not.toContain("/regen-log-rekey/");
  });

  it("reads out staging residue from an earlier interrupted run", () => {
    expect(at("await reportRegenLogStagingResidue(")).toBeLessThan(at("await rekeyOne(a, store)"));
  });
});

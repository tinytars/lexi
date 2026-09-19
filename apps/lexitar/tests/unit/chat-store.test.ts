import { describe, it, expect, beforeEach, vi } from "vitest";
import { encryptVaultV2, generateDEK } from "@tinytars/vault/crypto";
import type { Thread } from "../../src/lib/chat-threads";

// W71 — chat-store had no tests at all, and it holds PHI on the same
// read-decrypt-overwrite path the vault does.
//
// Two defects, both silent. `loadThreads` swallowed every decrypt failure and returned null, which
// the caller reads as "no history"; the patient's next message then encrypted an empty thread list
// over the blob that could not be read. And the PUT carried no precondition, so two tabs on the same
// conversation each wrote the whole blob and the later one won — the lost update W70 fixed for the
// vault, still live here.
//
// These run against the R2 transport, driving a fake fetch that behaves like the real Function: etag
// on GET, 412 on a failed If-Match. `DEV` has to be stubbed off because vitest sets it — and the
// localStorage branch it otherwise takes is the one path where none of this applies.

const threads = (label: string): Thread[] => [{ id: "t1", title: label, messages: [] } as unknown as Thread];

function fakeServer() {
  const state = { blob: null as Uint8Array | null, etag: "", seq: 0, puts: 0 };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init || (init.method ?? "GET") === "GET") {
      if (!state.blob) return new Response(null, { status: 404 });
      return new Response(state.blob as BodyInit, { status: 200, headers: { etag: state.etag } });
    }
    const headers = new Headers(init.headers);
    const ifMatch = headers.get("If-Match");
    const ifNoneMatch = headers.get("If-None-Match");
    if (ifMatch && ifMatch !== state.etag) return new Response(null, { status: 412 });
    if (ifNoneMatch === "*" && state.blob) return new Response(null, { status: 412 });
    state.puts++;
    state.blob = new Uint8Array(init.body as ArrayBuffer);
    state.etag = `e${++state.seq}`;
    return new Response(null, { status: 204, headers: { etag: state.etag } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

/**
 * A fresh module instance — i.e. a fresh browser tab.
 *
 * chat-store keeps the etag map and the unreadable set at module level, deliberately: they belong to
 * the connection, not to a component that unmounts when the user switches away. That makes a shared
 * import leak one test's tokens into the next, so every test that means "a different tab" has to say
 * so explicitly.
 */
const tab = () => { vi.resetModules(); return import("../../src/lib/chat-store"); };

let dek: CryptoKey;
let other: CryptoKey;
let loadThreads: (id: string, dek: CryptoKey) => Promise<Thread[] | null>;
let saveThreads: (t: Thread[], id: string, dek: CryptoKey) => Promise<void>;
beforeEach(async () => {
  vi.stubEnv("DEV", false);
  ({ loadThreads, saveThreads } = await tab());
  dek = await generateDEK();
  other = await generateDEK();
});

describe("a conversation that cannot be opened is not overwritten", () => {
  it("refuses to save over a blob the current key cannot decrypt", async () => {
    const server = fakeServer();
    // Something readable is already stored — under a DIFFERENT key (a rotation mid-flight, an unlock
    // that has not landed). This is the case that used to destroy it.
    server.blob = await encryptVaultV2({ threads: threads("theirs") }, other);
    server.etag = "e0";
    const putsBefore = server.puts;

    expect(await loadThreads("Alex", dek)).toBeNull(); // opens fresh, as it should
    await expect(saveThreads(threads("mine"), "Alex", dek)).rejects.toThrow(/not overwriting/i);
    expect(server.puts).toBe(putsBefore);

    // And the original is still there, still openable by whoever holds the right key.
    await expect((await import("@tinytars/vault/crypto")).decryptVaultV2<{ threads: Thread[] }>(server.blob!, other)).resolves.toBeTruthy();
  });

  it("saves normally once the right key opens it", async () => {
    const server = fakeServer();
    server.blob = await encryptVaultV2({ threads: threads("theirs") }, other);
    server.etag = "e0";
    expect(await loadThreads("Alex", dek)).toBeNull();
    await expect(saveThreads(threads("mine"), "Alex", dek)).rejects.toThrow();

    // A later load with the correct key clears the block — the refusal is about THIS blob, not a
    // permanent state the tab can never leave.
    expect((await loadThreads("Alex", other))![0].title).toBe("theirs");
    await expect(saveThreads(threads("mine"), "Alex", other)).resolves.toBeUndefined();
  });

  it("a client that has genuinely never saved still starts fresh and saves", async () => {
    fakeServer();
    expect(await loadThreads("Alex", dek)).toBeNull();
    await expect(saveThreads(threads("first"), "Alex", dek)).resolves.toBeUndefined();
  });
});

describe("two tabs cannot silently overwrite each other", () => {
  it("round-trips through the etag the server handed back", async () => {
    fakeServer();
    await saveThreads(threads("one"), "Alex", dek);
    await saveThreads(threads("two"), "Alex", dek); // uses the etag from the first save
    expect((await loadThreads("Alex", dek))![0].title).toBe("two");
  });

  it("the second tab is refused rather than allowed to discard the first tab's write", async () => {
    const server = fakeServer();
    await saveThreads(threads("tab A"), "Alex", dek);
    const winner = server.blob;

    // Tab B never read the blob, so it has no token: it must claim create-only and lose.
    const fresh = await tab();
    await expect(fresh.saveThreads(threads("tab B"), "Alex", dek)).rejects.toThrow(/another tab/i);
    expect(server.blob).toBe(winner);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { encryptVaultV2, generateDEK } from "@tinytars/vault/crypto";
import { createChatThreadSession, type ChatThreadSessionDeps } from "../../src/lib/chat-thread-session.svelte";
import type { Thread } from "../../src/lib/chat-threads";
import type { Vault } from "../../src/lib/types";
import type { Permalink } from "../../src/lib/permalink";

// A vault DEK rotation replaces session.dek in place — vault-principals' rotateVaultKey(), reached
// both from revoking an active support principal and from App's boot-time resume of a deferred
// rotation. The selected client never changes across it, and nothing in that path touches the
// per-client chat blob: re-keying the conversation this tab already holds is the chat session's job,
// because it is the only thing that still has the plaintext.
//
// Left undone, the blob stays encrypted under the key the rotation discarded. Every later reader —
// the next session, a second tab — gets ciphertext it cannot open, chat-store latches the client as
// unreadable (correctly: it will not write over a conversation nobody can read), and from then on
// every save of that conversation is refused. So the assertion here is about the STORE, not about the
// in-memory thread list: after the key moves, what is on the server has to open with the key the app
// now holds.
//
// Runs against the R2 transport like chat-store.test.ts, for the same reason: DEV takes the
// localStorage branch, where none of the etag/precondition behaviour this depends on exists.

const CLIENT = "robin";

const conversation = (title: string, texts: string[]): Thread[] => [
  { id: "t4", title, pinned: false, turns: texts.map((text) => ({ role: "user" as const, text })), seq: 4, lastActivityAt: 7 },
];

/** Stands in for /api/chat-history/{id}: an etag on GET, 412 on a precondition that no longer holds. */
function fakeServer() {
  const state = { blob: null as Uint8Array | null, etag: "e0" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        if (!state.blob) return new Response(null, { status: 404 });
        return new Response(state.blob as BodyInit, { status: 200, headers: { etag: state.etag } });
      }
      const headers = new Headers(init?.headers);
      const ifMatch = headers.get("If-Match");
      if (ifMatch && ifMatch !== state.etag) return new Response(null, { status: 412, headers: { etag: state.etag } });
      if (headers.get("If-None-Match") === "*" && state.blob) return new Response(null, { status: 412, headers: { etag: state.etag } });
      state.blob = new Uint8Array(init!.body as ArrayBuffer);
      state.etag = `e${Number(state.etag.slice(1)) + 1}`;
      return new Response(null, { status: 204, headers: { etag: state.etag } });
    }),
  );
  return state;
}

/** A fresh module instance — chat-store's etag map and unreadable set belong to the tab, not the test. */
const tab = () => { vi.resetModules(); return import("../../src/lib/chat-store"); };

/** Past the 500ms persist debounce and whatever encrypt/fetch it then awaits. */
const settle = () => new Promise((r) => setTimeout(r, 700));

function makeHarness(store: ChatThreadSessionDeps["store"], dek: CryptoKey) {
  const state = {
    dek: dek as CryptoKey | null,
    section: null as string | null,
    seed: null as Permalink | null,
  };
  const session = createChatThreadSession({
    getSelectedClientId: () => CLIENT,
    getDek: () => state.dek,
    getVault: () => ({ clients: {} }) as unknown as Vault,
    isChatTab: () => true,
    getSection: () => state.section,
    setSection: (v) => { state.section = v; },
    getChatSeedRequest: () => state.seed,
    setChatSeedRequest: (v) => { state.seed = v; },
    confirmDelete: () => true,
    store,
  });
  return { state, session };
}

let oldDek: CryptoKey;
let newDek: CryptoKey;
beforeEach(async () => {
  vi.stubEnv("DEV", false);
  oldDek = await generateDEK();
  newDek = await generateDEK();
});

describe("a DEK rotation carries the stored conversation with it", () => {
  it("re-encrypts the open conversation under the new key, so a later reader can still open it", async () => {
    const server = fakeServer();
    server.blob = await encryptVaultV2({ threads: conversation("ankle brace", ["how long do I wear it"]) }, oldDek);
    const store = await tab();
    const { state, session } = makeHarness(store, oldDek);

    await session.hydrate();
    expect(session.threads.map((t) => t.title)).toEqual(["ankle brace"]);

    // The rotation: a fresh DEK on the same open client. The effect that wraps hydrate() re-runs
    // because getDek() is reactive — this is that re-run.
    state.dek = newDek;
    session.hydrate();
    await settle(); // past the persist debounce; real timers, because the save awaits real WebCrypto

    // The next reader holds only the new key, and the conversation has to survive for it.
    const later = await tab();
    const restored = await later.loadThreads(CLIENT, newDek);
    expect(restored?.map((t) => t.title)).toEqual(["ankle brace"]);
    expect(restored?.[0].turns.map((t) => t.text)).toEqual(["how long do I wear it"]);

    // And because it opened, that reader is free to write — which is what a stranded blob costs.
    await expect(later.saveThreads(conversation("ankle brace", ["how long do I wear it", "six weeks"]), CLIENT, newDek)).resolves.toBeUndefined();
  });

  it("does not write anything back when this tab never opened a stored conversation", async () => {
    const server = fakeServer(); // nothing stored: the client has never chatted
    const store = await tab();
    const { state, session } = makeHarness(store, oldDek);

    await session.hydrate();
    state.dek = newDek;
    session.hydrate();
    await settle();

    expect(server.blob).toBeNull();
  });
});

// A history load that fails outright is not the same as a history that loads empty, and the
// difference only shows when the session has already held someone else's conversation. Switching
// client runs hydrate again; the success path always replaces the thread list, so the failure path
// is the one place where the previous client's turns can stay in memory under the new client's id —
// and then be written there by the next save.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChatThreadSession, type ChatThreadSessionDeps } from "../../src/lib/chat-thread-session.svelte";
import type { Thread } from "../../src/lib/chat-threads";
import type { Vault } from "../../src/lib/types";

const store = {
  loadThreads: vi.fn(async (): Promise<Thread[] | null> => null),
  saveThreads: vi.fn(async () => {}),
  isUnreadable: vi.fn((): boolean => false),
  replaceUnreadableHistory: vi.fn(async (): Promise<void> => {}),
};

const storedThread = (): Thread => ({
  id: "stored-1",
  title: "earlier conversation",
  pinned: false,
  turns: [{ role: "user", text: "a turn only the first client ever had" }] as unknown as Thread["turns"],
  seq: 4,
  lastActivityAt: 1,
});

function makeHarness() {
  const state = {
    selectedClientId: "robin" as string | null,
    section: null as string | null,
  };
  const deps: ChatThreadSessionDeps = {
    getSelectedClientId: () => state.selectedClientId,
    getDek: () => ({}) as CryptoKey,
    getVault: () => ({ clients: {} }) as unknown as Vault,
    isChatTab: () => true,
    getSection: () => state.section,
    setSection: (v) => {
      state.section = v;
    },
    getChatSeedRequest: () => null,
    setChatSeedRequest: () => {},
    confirmDelete: () => true,
    store,
  };
  return { state, session: createChatThreadSession(deps) };
}

beforeEach(() => {
  store.loadThreads.mockReset().mockResolvedValue(null);
  store.saveThreads.mockReset().mockResolvedValue(undefined);
  store.isUnreadable.mockReset().mockReturnValue(false);
  store.replaceUnreadableHistory.mockReset().mockResolvedValue(undefined);
});

describe("hydrate when the stored history cannot be fetched", () => {
  /** First client hydrates with a real conversation, then the selection moves to one whose load throws. */
  async function switchedAfterAFailedLoad() {
    const h = makeHarness();
    store.loadThreads.mockResolvedValue([storedThread()]);
    await h.session.hydrate();
    expect(h.session.threads.map((t) => t.id)).toEqual(["stored-1"]);

    h.state.selectedClientId = "sam";
    store.loadThreads.mockRejectedValue(new Error("transport refused the read"));
    await h.session.hydrate();
    return h;
  }

  it("opens a fresh thread rather than keeping the previous client's conversation", async () => {
    const { session } = await switchedAfterAFailedLoad();
    expect(session.hydrated).toBe(true);
    expect(session.threads).toHaveLength(1);
    expect(session.threads[0].id).not.toBe("stored-1");
    expect(session.threads[0].turns).toEqual([]);
  });

  it("never writes the previous client's turns under the newly selected client", async () => {
    vi.useFakeTimers();
    try {
      const { session } = await switchedAfterAFailedLoad();
      session.persistChatThreads();
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();

      expect(store.saveThreads).toHaveBeenCalledTimes(1);
      const [saved, id] = store.saveThreads.mock.calls[0] as unknown as [Thread[], string];
      expect(id).toBe("sam");
      expect(saved.flatMap((t) => t.turns)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

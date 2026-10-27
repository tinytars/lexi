import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChatThreadSession, type ChatThreadSessionDeps } from "../../src/lib/chat-thread-session.svelte";
import { markerAnchor } from "../../src/lib/anchor";
import type { Thread } from "../../src/lib/chat-threads";
import type { Client, Vault } from "../../src/lib/types";
import type { Permalink } from "../../src/lib/permalink";

const chatStore = {
  loadThreads: vi.fn(async (): Promise<Thread[] | null> => null),
  saveThreads: vi.fn(async () => {}),
  // W71 — the two the escape hatch needs. `isUnreadable` is a plain predicate over a module-level
  // Set in the real store, which is exactly why the session captures it into $state rather than
  // reading it through a getter; this double is what lets that capture be asserted.
  isUnreadable: vi.fn((): boolean => false),
  replaceUnreadableHistory: vi.fn(async (): Promise<void> => {}),
};

const blair = { displayName: "Blair", results: [{ marker: "ApoB", date: "2026-01-01", value: 90, unit: "mg/dL" }] } as unknown as Client;

function makeHarness(overrides: Partial<ChatThreadSessionDeps> = {}) {
  const state = {
    selectedClientId: "blair" as string | null,
    dek: {} as CryptoKey | null,
    vault: { clients: { blair } } as unknown as Vault | null,
    activeTab: "chat",
    section: null as string | null,
    chatSeedRequest: null as Permalink | null,
  };
  const confirmDelete = vi.fn(() => true);
  const deps: ChatThreadSessionDeps = {
    getSelectedClientId: () => state.selectedClientId,
    getDek: () => state.dek,
    getVault: () => state.vault,
    isChatTab: () => state.activeTab === "chat",
    getSection: () => state.section,
    setSection: (v) => { state.section = v; },
    getChatSeedRequest: () => state.chatSeedRequest,
    setChatSeedRequest: (v) => { state.chatSeedRequest = v; },
    confirmDelete,
    store: chatStore,
    ...overrides,
  };
  const session = createChatThreadSession(deps);
  return { state, deps, confirmDelete, session };
}

beforeEach(() => {
  chatStore.loadThreads.mockReset().mockResolvedValue(null);
  chatStore.saveThreads.mockReset().mockResolvedValue(undefined);
  chatStore.isUnreadable.mockReset().mockReturnValue(false);
  chatStore.replaceUnreadableHistory.mockReset().mockResolvedValue(undefined);
});

describe("hydrate", () => {
  it("does nothing without a selected client", async () => {
    const { session } = makeHarness({ getSelectedClientId: () => null });
    await session.hydrate();
    expect(chatStore.loadThreads).not.toHaveBeenCalled();
  });

  it("does nothing without a dek", async () => {
    const { session } = makeHarness({ getDek: () => null });
    await session.hydrate();
    expect(chatStore.loadThreads).not.toHaveBeenCalled();
  });

  it("loads once per client id — a second call for the same id is a no-op", async () => {
    const { session } = makeHarness();
    await session.hydrate();
    await session.hydrate();
    expect(chatStore.loadThreads).toHaveBeenCalledTimes(1);
  });

  it("adopts the loaded threads when present", async () => {
    const loaded = [{ id: "t9", title: "old", pinned: false, turns: [], seq: 9, lastActivityAt: 1 }];
    chatStore.loadThreads.mockResolvedValue(loaded);
    const { session } = makeHarness();
    await session.hydrate();
    expect(session.threads.map((t) => t.id)).toEqual(["t9"]);
  });

  it("falls back to a fresh thread when loadThreads returns null", async () => {
    chatStore.loadThreads.mockResolvedValue(null);
    const { session } = makeHarness();
    const before = session.threads.map((t) => t.id);
    await session.hydrate();
    expect(session.threads).toHaveLength(1);
    expect(session.threads[0].id).not.toEqual(before[0]);
  });

  // W71 — an undecryptable blob loads as "no history", which is indistinguishable from a first-ever
  // chat from the threads alone. The flag is the only thing that tells them apart, and it has to be
  // read AFTER the load settles because the store decides readability inside loadThreads.
  it("records that the stored history could not be opened", async () => {
    chatStore.isUnreadable.mockReturnValue(true);
    const { session } = makeHarness();
    expect(session.unreadable).toBe(false); // nothing is claimed before the load has run
    await session.hydrate();
    expect(session.unreadable).toBe(true);
    expect(chatStore.isUnreadable).toHaveBeenCalledWith("blair");
  });

  it("leaves the flag clear for a history that opened normally", async () => {
    const { session } = makeHarness();
    await session.hydrate();
    expect(session.unreadable).toBe(false);
  });

  // W72 — a rotation replaces the DEK under a client this tab already has open (vault-principals'
  // rotateVaultKey), and the `$effect` wrapping hydrate re-runs with the same client id. Returning
  // early there is what left the conversation encrypted under the discarded key.
  //
  // Whether it survives the round trip is chat-rekey-on-dek-change.test.ts's question, against real
  // crypto and a fake server. What is pinned here is the DECISION, in the three directions it can be
  // got wrong — and it is expressible against this fake at all only because `state.dek` is a bare
  // placeholder object, so "a different key" is simply a second one.
  describe("a DEK that changes under an already-open client", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const stored = [{ id: "t9", title: "old", pinned: false, turns: [], seq: 9, lastActivityAt: 1 }];

    /** The rotation itself: same client, a different key object, and hydrate called again. */
    const rotate = async (session: { hydrate(): Promise<void> | undefined }, state: { dek: CryptoKey | null }) => {
      state.dek = {} as CryptoKey;
      session.hydrate();
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();
    };

    it("writes the open conversation back rather than returning early", async () => {
      chatStore.loadThreads.mockResolvedValue(stored);
      const { state, session } = makeHarness();
      await session.hydrate();

      await rotate(session, state);

      expect(chatStore.saveThreads).toHaveBeenCalledTimes(1);
      // And it does not re-read: the stored blob is under the key just discarded, so a load would
      // only prove it unopenable and latch the store's refusal to write over it.
      expect(chatStore.loadThreads).toHaveBeenCalledTimes(1);
    });

    it("writes nothing when this tab never restored a stored conversation", async () => {
      // A placeholder thread is not a conversation, and writing it would overwrite a blob this tab
      // has not read — the one way a prevention could cost more than the fault it prevents.
      chatStore.loadThreads.mockResolvedValue(null);
      const { state, session } = makeHarness();
      await session.hydrate();

      await rotate(session, state);

      expect(chatStore.saveThreads).not.toHaveBeenCalled();
    });

    it("writes nothing when the key has not actually changed", async () => {
      chatStore.loadThreads.mockResolvedValue(stored);
      const { session } = makeHarness();
      await session.hydrate();

      session.hydrate(); // the effect re-runs for an unrelated reason; the key is the same object
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();

      expect(chatStore.saveThreads).not.toHaveBeenCalled();
      expect(chatStore.loadThreads).toHaveBeenCalledTimes(1);
    });
  });
});

describe("applyChatFallback", () => {
  it("does nothing outside the chat tab", async () => {
    const { session, state } = makeHarness({ isChatTab: () => false });
    await session.hydrate();
    state.section = "missing";
    session.applyChatFallback();
    expect(state.section).toBe("missing");
  });

  it("does nothing before hydration completes", () => {
    const { session, state } = makeHarness();
    state.section = "missing";
    session.applyChatFallback();
    expect(state.section).toBe("missing");
  });

  it("does nothing when the active section is a real thread id, even when it isn't the sort-first one", async () => {
    const { session, state } = makeHarness();
    await session.hydrate();
    session.startNewChatThread();
    const [first, second] = session.threads;
    session.toggleChatThreadPin(second.id); // sorts second first, so first is no longer threads[0]
    state.section = first.id;
    session.applyChatFallback();
    expect(state.section).toBe(first.id);
  });

  it("falls back to the first sorted thread when the active section names no thread", async () => {
    const { session, state } = makeHarness();
    await session.hydrate();
    state.section = "not-a-thread-id";
    session.applyChatFallback();
    expect(state.section).toBe(session.threads[0].id);
  });
});

describe("resolveSeedRequest", () => {
  it("does nothing without a pending seed request", async () => {
    const { session } = makeHarness();
    await session.hydrate();
    const before = session.threads.length;
    session.resolveSeedRequest();
    expect(session.threads).toHaveLength(before);
  });

  it("does not consume the seed while unhydrated, even with a vault present", () => {
    const seed = { tab: "chat" } as Permalink;
    const { session, state } = makeHarness();
    state.chatSeedRequest = seed;
    session.resolveSeedRequest();
    expect(state.chatSeedRequest).toBe(seed);
  });

  it("does not consume the seed without a vault, even once hydrated", async () => {
    const seed = { tab: "chat" } as Permalink;
    const { session, state } = makeHarness({ getVault: () => null });
    await session.hydrate();
    state.chatSeedRequest = seed;
    session.resolveSeedRequest();
    expect(state.chatSeedRequest).toBe(seed);
  });

  it("seeds a new thread from a resolved reference and selects it", async () => {
    const { session, state } = makeHarness();
    await session.hydrate();
    const before = session.threads.length;
    state.chatSeedRequest = { client: "blair", tab: "markers", anchor: markerAnchor("ApoB") } as Permalink;
    session.resolveSeedRequest();
    expect(session.threads).toHaveLength(before + 1);
    const created = session.threads[session.threads.length - 1];
    expect(created.title).toContain("ApoB");
    expect(state.section).toBe(created.id);
    expect(state.chatSeedRequest).toBeNull();
  });
});

describe("thread actions", () => {
  it("startNewChatThread appends a thread and selects it", async () => {
    const { session, state } = makeHarness();
    const before = session.threads.length;
    session.startNewChatThread();
    expect(session.threads).toHaveLength(before + 1);
    expect(state.section).toBe(session.threads[session.threads.length - 1].id);
  });

  it("selectChatThread just sets the section", () => {
    const { session, state } = makeHarness();
    session.selectChatThread("t5");
    expect(state.section).toBe("t5");
  });

  it("toggleChatThreadPin flips only the targeted thread, and flips back on a second call", async () => {
    const { session } = makeHarness();
    await session.hydrate();
    session.startNewChatThread();
    const [a, b] = session.threads;
    session.toggleChatThreadPin(a.id);
    expect(session.threads.find((t) => t.id === a.id)!.pinned).toBe(true);
    expect(session.threads.find((t) => t.id === b.id)!.pinned).toBe(false);
    session.toggleChatThreadPin(a.id);
    expect(session.threads.find((t) => t.id === a.id)!.pinned).toBe(false);
  });

  it("deleteChatThread does nothing when confirmDelete declines", async () => {
    const { session, confirmDelete } = makeHarness();
    await session.hydrate();
    session.startNewChatThread();
    confirmDelete.mockReturnValue(false);
    const idsBefore = session.threads.map((t) => t.id);
    session.deleteChatThread(idsBefore[0]);
    expect(session.threads.map((t) => t.id)).toEqual(idsBefore);
  });

  it("deleteChatThread replaces the last remaining thread with a fresh one", () => {
    const { session } = makeHarness();
    const onlyId = session.threads[0].id;
    session.deleteChatThread(onlyId);
    expect(session.threads).toHaveLength(1);
    expect(session.threads[0].id).not.toBe(onlyId);
  });

  it("deleteChatThread reselects by sort order when the active thread is deleted", () => {
    const { session, state } = makeHarness();
    session.startNewChatThread();
    const [first, second] = session.threads;
    state.section = second.id;
    session.deleteChatThread(second.id);
    expect(session.threads.map((t) => t.id)).toEqual([first.id]);
    expect(state.section).toBe(first.id);
  });

  it("deleteChatThread leaves the active section alone when a different thread is deleted", () => {
    const { session, state } = makeHarness();
    session.startNewChatThread();
    const [first, second] = session.threads;
    state.section = first.id;
    session.deleteChatThread(second.id);
    expect(state.section).toBe(first.id);
  });

  it("commitChatRename is a no-op for an empty or whitespace-only title", () => {
    const { session } = makeHarness();
    const id = session.threads[0].id;
    const originalTitle = session.threads[0].title;
    session.renamingId = id;
    session.renameText = "   ";
    session.commitChatRename();
    expect(session.threads[0].title).toBe(originalTitle);
    expect(session.renamingId).toBeNull();
  });

  it("commitChatRename applies a trimmed title to the right thread only", () => {
    const { session } = makeHarness();
    session.startNewChatThread();
    const [target, other] = session.threads;
    const otherTitleBefore = other.title;
    session.renamingId = target.id;
    session.renameText = "  Renamed  ";
    session.commitChatRename();
    expect(session.threads.find((t) => t.id === target.id)!.title).toBe("Renamed");
    expect(session.threads.find((t) => t.id === other.id)!.title).toBe(otherTitleBefore);
    expect(session.renamingId).toBeNull();
  });
});

describe("persistChatThreads", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does nothing when threads have not been loaded for the current client", () => {
    const { session } = makeHarness();
    session.persistChatThreads();
    vi.advanceTimersByTime(1000);
    expect(chatStore.saveThreads).not.toHaveBeenCalled();
  });

  it("debounces rapid calls into a single save", async () => {
    const { session } = makeHarness();
    await session.hydrate();
    session.persistChatThreads();
    session.persistChatThreads();
    session.persistChatThreads();
    vi.advanceTimersByTime(500);
    await vi.runOnlyPendingTimersAsync();
    expect(chatStore.saveThreads).toHaveBeenCalledTimes(1);
  });

  // W71 — hydrating cleanly does not settle the question for the session's lifetime: saveThreads
  // re-reads the blob to resolve a conflict, and that read is where a rotation mid-session is first
  // noticed. Without this the banner would appear with no action under it.
  it("re-reads readability when a save fails", async () => {
    const { session } = makeHarness();
    await session.hydrate();
    chatStore.saveThreads.mockRejectedValue(new Error("not overwriting it"));
    chatStore.isUnreadable.mockReturnValue(true);
    session.persistChatThreads();
    vi.advanceTimersByTime(500);
    await vi.runOnlyPendingTimersAsync();
    expect(session.saveError).toBe("not overwriting it");
    expect(session.unreadable).toBe(true);
  });
});

// W71 — the escape hatch out of a permanently unreadable history. The guard it relieves is a good
// bet on a transient wrong DEK and a trap on a rotation that re-keyed the vault and never walked
// chat-, so what these cases hold is the narrowness: it is unavailable where nothing is wrong, it is
// never taken without being asked for, and a failed attempt leaves the refusal exactly as it was.
describe("setAsideUnreadableHistory", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** The state the hatch is offered in: a stored blob this session's key will not open. */
  async function stranded(overrides: Partial<ChatThreadSessionDeps> = {}) {
    chatStore.isUnreadable.mockReturnValue(true);
    const h = makeHarness(overrides);
    await h.session.hydrate();
    return h;
  }

  it("refuses a history that opened normally, without asking", async () => {
    const { session, confirmDelete } = makeHarness();
    await session.hydrate();
    await session.setAsideUnreadableHistory();
    expect(confirmDelete).not.toHaveBeenCalled();
    expect(chatStore.replaceUnreadableHistory).not.toHaveBeenCalled();
  });

  it("does nothing without a dek", async () => {
    const { session, confirmDelete } = await stranded({ getDek: () => null });
    await session.setAsideUnreadableHistory();
    expect(confirmDelete).not.toHaveBeenCalled();
    expect(chatStore.replaceUnreadableHistory).not.toHaveBeenCalled();
  });

  it("asks first, and says what is kept rather than only what changes", async () => {
    // Its own mock rather than the harness's: the prompt text is the subject here, so the stub has
    // to declare the argument it is asserted on.
    const asked = vi.fn((message: string) => message.length > 0);
    const { session } = await stranded({ confirmDelete: asked });
    await session.setAsideUnreadableHistory();
    const prompt = asked.mock.calls[0][0];
    expect(prompt).toMatch(/kept/);
    expect(prompt).toMatch(/not deleted/);
  });

  it("writes nothing on a decline, and leaves the refusal in force", async () => {
    const declined = vi.fn(() => false);
    const { session } = await stranded({ confirmDelete: declined });
    await session.setAsideUnreadableHistory();
    expect(declined).toHaveBeenCalled();
    expect(chatStore.replaceUnreadableHistory).not.toHaveBeenCalled();
    expect(session.unreadable).toBe(true);
  });

  it("replaces the history and clears both the refusal and the banner", async () => {
    const { session } = await stranded();
    chatStore.saveThreads.mockRejectedValue(new Error("not overwriting it"));
    session.persistChatThreads();
    vi.advanceTimersByTime(500);
    await vi.runOnlyPendingTimersAsync();
    expect(session.saveError).toBe("not overwriting it");

    chatStore.saveThreads.mockResolvedValue(undefined);
    await session.setAsideUnreadableHistory();
    expect(chatStore.replaceUnreadableHistory).toHaveBeenCalledWith(expect.any(Array), "blair", expect.anything());
    expect(session.unreadable).toBe(false);
    expect(session.saveError).toBeNull();
  });

  it("keeps the refusal and reports the failure when the write does not land", async () => {
    const { session } = await stranded();
    chatStore.replaceUnreadableHistory.mockRejectedValue(new Error("chat history save failed (500)"));
    await session.setAsideUnreadableHistory();
    expect(session.unreadable).toBe(true); // the banner and its action both stay
    expect(session.saveError).toBe("chat history save failed (500)");
  });

  // The lost update this would otherwise have: a debounced save armed before the click carries a
  // snapshot taken before it, and firing afterwards would replace the history with a staler version
  // of the very conversation that was just written.
  it("cancels a debounced save still pending", async () => {
    const { session } = await stranded();
    session.persistChatThreads();
    await session.setAsideUnreadableHistory();
    vi.advanceTimersByTime(1000);
    await vi.runOnlyPendingTimersAsync();
    expect(chatStore.saveThreads).not.toHaveBeenCalled();
  });
});

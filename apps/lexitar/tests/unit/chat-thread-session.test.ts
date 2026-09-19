import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChatThreadSession, type ChatThreadSessionDeps } from "../../src/lib/chat-thread-session.svelte";
import { markerAnchor } from "../../src/lib/anchor";
import type { Thread } from "../../src/lib/chat-threads";
import type { Client, Vault } from "../../src/lib/types";
import type { Permalink } from "../../src/lib/permalink";

const chatStore = {
  loadThreads: vi.fn(async (): Promise<Thread[] | null> => null),
  saveThreads: vi.fn(async () => {}),
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
});

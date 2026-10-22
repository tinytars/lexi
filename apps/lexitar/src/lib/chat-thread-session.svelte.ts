// Chat-thread orchestration extracted from App.svelte (W79 phase 3a): hydration, the
// fallback-to-first-thread effect, seed-request handling, debounced persistence, and the five
// thread actions. Owns the thread list and rename/hydration UI state itself (private $state,
// exposed via accessor pairs so `bind:` still works from Sidebar/ChatTab) — that state is
// intrinsically this concern's own, unlike roster-session.svelte.ts's vault, which stays with App
// because its lifetime is a security property App itself must own. Client selection, the DEK, the
// vault, and the active tab/section stay App-owned and are injected, since their lifetime and
// meaning belong to the whole app, not just chat.

import type { Vault } from "./types";
import type { Permalink } from "./permalink";
import { newThread, sortThreads, adoptThreads, seedNewThread, type Thread } from "./chat-threads";
import { loadThreads, saveThreads, isUnreadable, replaceUnreadableHistory } from "./chat-store";
import { resolveReference } from "./reference-resolver";
import { reportCaughtError } from "./error-reporter";

export interface ChatThreadSessionDeps {
  getSelectedClientId: () => string | null;
  getDek: () => CryptoKey | null;
  getVault: () => Vault | null;
  isChatTab: () => boolean;
  getSection: () => string | null;
  setSection: (id: string | null) => void;
  getChatSeedRequest: () => Permalink | null;
  setChatSeedRequest: (v: Permalink | null) => void;
  /** Injected in place of a bare `confirm(...)` call, so the guard is testable. */
  confirmDelete: (message: string) => boolean;
  /** Encrypted thread persistence; defaults to chat-store. */
  store?: {
    loadThreads: typeof loadThreads;
    saveThreads: typeof saveThreads;
    isUnreadable: typeof isUnreadable;
    replaceUnreadableHistory: typeof replaceUnreadableHistory;
  };
}

export interface ChatThreadSession {
  threads: Thread[];
  readonly hydrated: boolean;
  /** A save that failed and stayed failed. Cleared by the next save that succeeds, not by the next attempt. */
  readonly saveError: string | null;
  /**
   * The stored history exists but would not open with this session's key, so the store refuses every
   * save for this client. Distinct from `saveError`, which is the symptom: a 5xx also sets that, and
   * only this one has a way out.
   */
  readonly unreadable: boolean;
  renamingId: string | null;
  renameText: string;
  startNewChatThread(): void;
  selectChatThread(id: string): void;
  toggleChatThreadPin(id: string): void;
  deleteChatThread(id: string): void;
  commitChatRename(): void;
  persistChatThreads(): void;
  /**
   * W71 escape hatch — keep the unreadable history and save this conversation over it. Confirmed by
   * the patient first, and a no-op unless `unreadable` is true.
   */
  setAsideUnreadableHistory(): Promise<void>;
  /** Each `$effect` below is a thin reactive trigger over one of these three, exposed so tests can call them directly. */
  hydrate(): Promise<void> | undefined;
  applyChatFallback(): void;
  resolveSeedRequest(): void;
}

// The reporter fingerprints by `name: message`, so a bare Error would bucket a failed chat save with
// every other Error carrying the same text.
function named(err: unknown, name: string): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  e.name = name;
  return e;
}

export function createChatThreadSession(deps: ChatThreadSessionDeps): ChatThreadSession {
  let chatThreads = $state<Thread[]>([newThread()]);
  let chatRenamingId = $state<string | null>(null);
  let chatRenameText = $state("");
  let chatLoadedForId = $state<string | null>(null);
  let chatHydrated = $state(false);
  let chatSaveError = $state<string | null>(null);
  let chatUnreadable = $state(false);
  let chatSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const store = deps.store ?? { loadThreads, saveThreads, isUnreadable, replaceUnreadableHistory };

  function hydrate() {
    const id = deps.getSelectedClientId();
    const key = deps.getDek();
    if (!id || !key || chatLoadedForId === id) return;
    chatLoadedForId = id;
    return store.loadThreads(id, key)
      .then((loaded) => {
        chatThreads = loaded && loaded.length ? adoptThreads(loaded) : [newThread()];
      })
      .catch((e) => {
        // Opening fresh is still right — a chat tab that will not open is worse than an empty one.
        // What was wrong is that this was the ONLY record of the failure, and it lived in a
        // swallowed promise: a 5xx here leaves the tab with no etag, and the user none the wiser.
        //
        // Opening fresh also has to be done, not just intended. Only the success path above replaced
        // the thread list, so a failed load left the PREVIOUSLY hydrated client's conversation in
        // place while chatLoadedForId already named the new one — rendered under the wrong client,
        // and written there by the next save.
        chatThreads = [newThread()];
        reportCaughtError(named(e, "ChatHistoryLoadFailed"));
      })
      .finally(() => {
        // Read after the load settles, not before: the store decides readability INSIDE loadThreads,
        // and this flag is the whole difference between a banner with an action under it and a dead
        // end. A client that opened normally reads false, which is what keeps the hatch unofferable
        // on a conversation nothing is wrong with.
        chatUnreadable = store.isUnreadable(id);
        chatHydrated = true;
      });
  }

  function applyChatFallback() {
    if (deps.isChatTab() && chatHydrated && !chatThreads.some((t) => t.id === deps.getSection())) {
      deps.setSection(sortThreads(chatThreads)[0]?.id ?? null);
    }
  }

  function resolveSeedRequest() {
    const seed = deps.getChatSeedRequest();
    if (!seed) return;
    const vault = deps.getVault();
    if (!vault || !chatHydrated) return;
    const thread = seedNewThread(resolveReference(vault, deps.getSelectedClientId(), seed));
    chatThreads = [...chatThreads, thread];
    deps.setSection(thread.id);
    persistChatThreads();
    deps.setChatSeedRequest(null);
  }

  $effect(() => {
    hydrate();
  });

  $effect(() => {
    applyChatFallback();
  });

  $effect(() => {
    resolveSeedRequest();
  });

  function persistChatThreads() {
    const id = deps.getSelectedClientId();
    const key = deps.getDek();
    if (!id || !key || chatLoadedForId !== id) return;
    const snapshot = $state.snapshot(chatThreads) as Thread[];
    if (chatSaveTimer) clearTimeout(chatSaveTimer);
    chatSaveTimer = setTimeout(() => {
      store
        .saveThreads(snapshot, id, key)
        .then(() => {
          chatSaveError = null; // cleared by a success, not by the next attempt
        })
        .catch((e) => {
          // Threads are rendered from memory, so an unsaved conversation looks identical to a saved
          // one until the next load finds it missing. The store already retries a conflict once;
          // reaching here means it could not be resolved, which is a defect worth filing.
          chatSaveError = (e as Error).message;
          // A save can be the first thing to discover it: the store re-reads the blob to resolve a
          // conflict and may find it undecryptable then, long after this client hydrated cleanly.
          chatUnreadable = store.isUnreadable(id);
          reportCaughtError(named(e, "ChatSaveFailed"));
        });
    }, 500);
  }

  // Shown in a confirm() before anything is written, so it has to say what survives rather than only
  // what changes. "Kept" is the load-bearing word: the route copies the old ciphertext aside before
  // the overwrite, so this displaces a conversation and never destroys one.
  const SET_ASIDE_PROMPT =
    "Set the earlier conversation aside and save this one?\n\n" +
    "The earlier conversation can't be opened with your current key, which is why nothing has been " +
    "saving. It is kept, still encrypted, and is not deleted — but it stays unreadable unless its " +
    "original key is recovered. Saving starts working again straight away.";

  async function setAsideUnreadableHistory(): Promise<void> {
    const id = deps.getSelectedClientId();
    const key = deps.getDek();
    if (!id || !key || !chatUnreadable) return;
    if (!deps.confirmDelete(SET_ASIDE_PROMPT)) return;
    const snapshot = $state.snapshot(chatThreads) as Thread[];
    // Drop any debounced save still pending: it carries an older snapshot and would land AFTER this
    // write, so leaving it armed would replace the history with a staler version of itself.
    if (chatSaveTimer) {
      clearTimeout(chatSaveTimer);
      chatSaveTimer = null;
    }
    try {
      await store.replaceUnreadableHistory(snapshot, id, key);
      chatUnreadable = false;
      chatSaveError = null;
    } catch (e) {
      // The refusal stays in force — the store only clears it once the write lands — so the banner
      // and its action both remain, which is the correct state after a failed attempt.
      chatSaveError = (e as Error).message;
      reportCaughtError(named(e, "ChatSetAsideFailed"));
    }
  }

  function startNewChatThread() {
    const t = newThread();
    chatThreads = [...chatThreads, t];
    deps.setSection(t.id);
  }

  function selectChatThread(id: string) {
    deps.setSection(id);
  }

  function toggleChatThreadPin(id: string) {
    chatThreads = chatThreads.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t));
    persistChatThreads();
  }

  function deleteChatThread(id: string) {
    if (!deps.confirmDelete("Delete this conversation? It can't be undone.")) return;
    const remaining = chatThreads.filter((t) => t.id !== id);
    chatThreads = remaining.length > 0 ? remaining : [newThread()];
    if (deps.getSection() === id) deps.setSection(sortThreads(chatThreads)[0].id);
    persistChatThreads();
  }

  function commitChatRename() {
    const id = chatRenamingId;
    const title = chatRenameText.trim();
    if (id && title) chatThreads = chatThreads.map((t) => (t.id === id ? { ...t, title } : t));
    chatRenamingId = null;
    persistChatThreads();
  }

  return {
    get threads() {
      return chatThreads;
    },
    set threads(v: Thread[]) {
      chatThreads = v;
    },
    get hydrated() {
      return chatHydrated;
    },
    get saveError() {
      return chatSaveError;
    },
    get unreadable() {
      return chatUnreadable;
    },
    get renamingId() {
      return chatRenamingId;
    },
    set renamingId(v: string | null) {
      chatRenamingId = v;
    },
    get renameText() {
      return chatRenameText;
    },
    set renameText(v: string) {
      chatRenameText = v;
    },
    startNewChatThread,
    selectChatThread,
    toggleChatThreadPin,
    deleteChatThread,
    commitChatRename,
    persistChatThreads,
    setAsideUnreadableHistory,
    hydrate,
    applyChatFallback,
    resolveSeedRequest,
  };
}

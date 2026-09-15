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
import { loadThreads, saveThreads } from "./chat-store";
import { resolveReference } from "./reference-resolver";

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
}

export interface ChatThreadSession {
  threads: Thread[];
  renamingId: string | null;
  renameText: string;
  startNewChatThread(): void;
  selectChatThread(id: string): void;
  toggleChatThreadPin(id: string): void;
  deleteChatThread(id: string): void;
  commitChatRename(): void;
  persistChatThreads(): void;
  /** Exposed so tests can drive the hydration/fallback/seed effects directly — `$effect` bodies
   * don't run under this repo's Vitest setup (see draft-sync.svelte.ts), so each effect below is a
   * thin reactive trigger over one of these three, which is what the tests call. */
  hydrate(): Promise<void> | undefined;
  applyChatFallback(): void;
  resolveSeedRequest(): void;
}

export function createChatThreadSession(deps: ChatThreadSessionDeps): ChatThreadSession {
  let chatThreads = $state<Thread[]>([newThread()]);
  let chatRenamingId = $state<string | null>(null);
  let chatRenameText = $state("");
  let chatLoadedForId = $state<string | null>(null);
  let chatHydrated = $state(false);
  let chatSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function hydrate() {
    const id = deps.getSelectedClientId();
    const key = deps.getDek();
    if (!id || !key || chatLoadedForId === id) return;
    chatLoadedForId = id;
    return loadThreads(id, key)
      .then((loaded) => {
        chatThreads = loaded && loaded.length ? adoptThreads(loaded) : [newThread()];
      })
      .catch(() => {})
      .finally(() => {
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
    const resolved = resolveReference(vault, deps.getSelectedClientId(), seed);
    if (!resolved) {
      deps.setChatSeedRequest(null);
      return;
    }
    const thread = seedNewThread(resolved);
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
      saveThreads(snapshot, id, key).catch(() => {});
    }, 500);
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
    hydrate,
    applyChatFallback,
    resolveSeedRequest,
  };
}

// M104 — the one shared "which popover is open" registry every menu-style popover
// (LeafActionMenu, AccountMenu) consults, so opening any one closes any other open one anywhere in
// the app. First true singleton runes module in this codebase (draft-sync.svelte.ts is a
// per-call-site factory, not a singleton — this module's state is created once, at import time,
// and shared by every caller).
const state = $state<{ openId: string | null }>({ openId: null });

export const menuRegistry = {
  isOpen(id: string): boolean {
    return state.openId === id;
  },
  open(id: string): void {
    state.openId = id;
  },
  close(id: string): void {
    if (state.openId === id) state.openId = null;
  },
};

// Navigation decision logic extracted from App.svelte's `applyNav`/`navigate` (W79 phase 3a). Plain
// TS, no runes — every piece of App-owned state this needs to read or write is an injected
// getter/setter, following roster-session.svelte.ts's dependency-injection shape. `tick` is imported
// directly rather than injected: it's a free function of the pending update queue, not App state.

import { tick } from "svelte";
import type { Tab } from "./nav";
import type { Permalink } from "./permalink";
import { resolveNestedSection, ANCHOR_ELIGIBLE_SECTIONS } from "./nav-decisions";

export interface NavControllerDeps {
  clientExists: (id: string) => boolean;
  getSelectedClientId: () => string | null;
  setSelectedClientId: (id: string | null) => void;
  getActiveTab: () => Tab;
  setActiveTab: (tab: Tab) => void;
  getSection: () => string | null;
  setSection: (section: string | null) => void;
  setActiveGroup: (group: string | null) => void;
  setActiveLeaf: (leaf: string | null) => void;
  setPendingAnchor: (anchor: string | null) => void;
  setPendingSidebarAction: (action: { section?: string; verb: "new" | "add" } | null) => void;
  setSearchOpen: (open: boolean) => void;
  resolveAnchor: (id: string) => Promise<void>;
  rememberSection: () => void;
}

export interface NavController {
  applyNav(pl: Permalink): Promise<void>;
  navigate(patch: Partial<Permalink>): Promise<void>;
}

export function createNavController(deps: NavControllerDeps): NavController {
  function applySectionChange(newSection: string | null) {
    const [resolved, nestedGroup] = resolveNestedSection(newSection);
    if (resolved !== deps.getSection()) {
      deps.setActiveGroup(null);
      deps.setActiveLeaf(null);
    }
    deps.setSection(resolved);
    if (nestedGroup) deps.setActiveGroup(nestedGroup);
    return resolved;
  }

  function applyAnchor(anchor: string | undefined | null) {
    if (!anchor) return;
    if (ANCHOR_ELIGIBLE_SECTIONS.has(deps.getSection() ?? "")) deps.setPendingAnchor(anchor);
    void deps.resolveAnchor(anchor);
  }

  async function applyNav(pl: Permalink): Promise<void> {
    deps.setPendingSidebarAction(null);
    deps.setSearchOpen(false);
    if (pl.client && deps.clientExists(pl.client)) deps.setSelectedClientId(pl.client);
    const tabChanging = pl.tab !== deps.getActiveTab();
    deps.setActiveTab(pl.tab);
    if (tabChanging) await tick();
    applySectionChange(pl.section ?? null);
    applyAnchor(pl.anchor);
    deps.rememberSection();
  }

  async function navigate(patch: Partial<Permalink>): Promise<void> {
    deps.setPendingSidebarAction(null);
    deps.setSearchOpen(false);
    if ("client" in patch) deps.setSelectedClientId(patch.client ?? null);
    const tabChanging = "tab" in patch && !!patch.tab && patch.tab !== deps.getActiveTab();
    if ("tab" in patch && patch.tab) deps.setActiveTab(patch.tab);
    if (tabChanging) await tick();
    if ("section" in patch) applySectionChange(patch.section ?? null);
    applyAnchor(patch.anchor);
    deps.rememberSection();
  }

  return { applyNav, navigate };
}

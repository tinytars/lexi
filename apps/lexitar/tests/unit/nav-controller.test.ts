import { describe, it, expect, vi, beforeEach } from "vitest";

const svelte = vi.hoisted(() => ({ tick: vi.fn(() => Promise.resolve()) }));
vi.mock("svelte", () => svelte);

import { createNavController, type NavControllerDeps } from "../../src/lib/nav-controller";
import type { Tab } from "../../src/lib/nav";

function makeHarness() {
  const state = {
    selectedClientId: null as string | null,
    activeTab: "chat" as Tab,
    section: null as string | null,
    activeGroup: "prior-group" as string | null,
    activeLeaf: "prior-leaf" as string | null,
    pendingAnchor: null as string | null,
    pendingSidebarAction: { section: "x", verb: "new" as const } as { section?: string; verb: "new" | "add" } | null,
    searchOpen: true,
  };
  const clients = new Set<string>();
  const deps: NavControllerDeps = {
    clientExists: (id) => clients.has(id),
    getSelectedClientId: () => state.selectedClientId,
    setSelectedClientId: (id) => { state.selectedClientId = id; },
    getActiveTab: () => state.activeTab,
    setActiveTab: (tab) => { state.activeTab = tab; },
    getSection: () => state.section,
    setSection: (s) => { state.section = s; },
    setActiveGroup: (g) => { state.activeGroup = g; },
    setActiveLeaf: (l) => { state.activeLeaf = l; },
    setPendingAnchor: (a) => { state.pendingAnchor = a; },
    setPendingSidebarAction: (a) => { state.pendingSidebarAction = a; },
    setSearchOpen: (open) => { state.searchOpen = open; },
    resolveAnchor: vi.fn(async () => {}),
    rememberSection: vi.fn(),
  };
  return { state, deps, clients, nav: createNavController(deps) };
}

beforeEach(() => {
  svelte.tick.mockClear();
});

describe("createNavController.navigate", () => {
  it("clears pendingSidebarAction and searchOpen, then calls rememberSection, on every call", async () => {
    const { state, deps, nav } = makeHarness();
    await nav.navigate({});
    expect(state.pendingSidebarAction).toBeNull();
    expect(state.searchOpen).toBe(false);
    expect(deps.rememberSection).toHaveBeenCalledTimes(1);
  });

  it("awaits tick only when the tab actually changes", async () => {
    const { nav } = makeHarness();
    await nav.navigate({ tab: "chat" });
    expect(svelte.tick).not.toHaveBeenCalled();

    await nav.navigate({ tab: "labs" });
    expect(svelte.tick).toHaveBeenCalledTimes(1);
  });

  it("resets activeGroup/activeLeaf only when the resolved section actually changes", async () => {
    const { state, nav } = makeHarness();
    state.section = "markers";
    await nav.navigate({ section: "markers" });
    expect(state.activeGroup).toBe("prior-group");
    expect(state.activeLeaf).toBe("prior-leaf");

    await nav.navigate({ section: "treatment" });
    expect(state.section).toBe("treatment");
    expect(state.activeGroup).toBeNull();
    expect(state.activeLeaf).toBeNull();
  });

  it("redirects a notes-nested section key and sets the nested group", async () => {
    const { state, nav } = makeHarness();
    await nav.navigate({ section: "docInference" });
    expect(state.section).toBe("notes");
    expect(state.activeGroup).toBe("docInference");
  });

  it("leaves section untouched when the patch omits it", async () => {
    const { state, nav } = makeHarness();
    state.section = "markers";
    await nav.navigate({ tab: "labs" });
    expect(state.section).toBe("markers");
  });

  it("gates pendingAnchor by section eligibility but always resolves the anchor", async () => {
    const { state, deps, nav } = makeHarness();
    await nav.navigate({ section: "markers", anchor: "leaf-1" });
    expect(state.pendingAnchor).toBe("leaf-1");
    expect(deps.resolveAnchor).toHaveBeenCalledWith("leaf-1");

    state.pendingAnchor = null;
    await nav.navigate({ section: "notes", anchor: "leaf-2" });
    expect(state.pendingAnchor).toBeNull();
    expect(deps.resolveAnchor).toHaveBeenCalledWith("leaf-2");
  });

  it("does not check clientExists — an explicit client patch is applied unconditionally", async () => {
    const { state, nav } = makeHarness();
    await nav.navigate({ client: "unknown-client" });
    expect(state.selectedClientId).toBe("unknown-client");
  });
});

describe("createNavController.applyNav", () => {
  it("only honours a client that resolves in the current vault", async () => {
    const { state, clients, nav } = makeHarness();
    clients.add("blair");
    await nav.applyNav({ tab: "chat", client: "blair" });
    expect(state.selectedClientId).toBe("blair");

    await nav.applyNav({ tab: "chat", client: "ghost" });
    expect(state.selectedClientId).toBe("blair");
  });

  it("awaits tick only when the tab actually changes", async () => {
    const { nav } = makeHarness();
    await nav.applyNav({ tab: "chat" });
    expect(svelte.tick).not.toHaveBeenCalled();

    await nav.applyNav({ tab: "labs" });
    expect(svelte.tick).toHaveBeenCalledTimes(1);
  });

  it("treats a missing section as null, resetting group/leaf from a prior section", async () => {
    const { state, nav } = makeHarness();
    state.section = "markers";
    await nav.applyNav({ tab: "chat" });
    expect(state.section).toBeNull();
    expect(state.activeGroup).toBeNull();
    expect(state.activeLeaf).toBeNull();
  });
});

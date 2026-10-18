// Extracted from App.svelte's triggerSidebarAction (W79 phase 3b) — the pure decision of what a
// sidebar row's "+"/rename action resolves to. The actual navigate() call and the three possible
// follow-on effects (starting a chat thread, opening the Import modal, or stashing a pending action for
// the freshly-mounted leaf to consume) stay in App.svelte; this only decides which one applies.

import type { Tab } from "./nav";

export type SidebarActionOutcome =
  | { navigate: { tab: Tab; section: undefined }; effect: "startNewChatThread" }
  | { navigate: { tab: Tab; section: string }; effect: "openImport" }
  | { navigate: { tab: Tab; section: string | undefined }; effect: "setPending"; pending: { section: string; verb: "new" | "add" } };

export function decideSidebarAction(
  key: string,
  verb: "new" | "add",
  sectionTab: Record<string, Tab>,
): SidebarActionOutcome {
  if (key === "chat") {
    const navigate = { tab: "chat" as Tab, section: undefined };
    if (verb === "new") return { navigate, effect: "startNewChatThread" };
    return { navigate, effect: "setPending", pending: { section: key, verb } };
  }
  const navigate = { tab: sectionTab[key], section: key };
  // M84 — Markers/Reports' "+" opens the existing Import modal directly; they have no per-section Add
  // UI for a pending action to relay to.
  if (key === "markers" || key === "healthReports") return { navigate, effect: "openImport" };
  return { navigate, effect: "setPending", pending: { section: key, verb } };
}

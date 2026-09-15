import type { Client } from "./types";

// A subtab's local edit draft must resync from a fresh `client` prop on a genuine change (the
// user's own Save, an import landing, a patient switch) but NOT when only `finding` changed — the
// W15c background regroup (App.svelte:277-308) and the manual Refresh button (App.svelte:904-927)
// both write `{...c, finding: {...}}`, preserving every other key's reference. Every legitimate
// writer (saveEdits' normalizeClientDraft, import-flow's full clones, patient switch) produces a
// new reference for at least one non-`finding` key, so comparing every other key by reference
// catches all of them while staying silent on a finding-only swap. If a future writer ever mutates
// a field in place without a new top-level Client object, this guard would miss it — keep every
// background/partial writer either finding-only-shaped or a full clone.
export function shouldResyncDraft(prev: Client | null, next: Client): boolean {
  if (!prev) return true;
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof Client>;
  for (const k of keys) {
    if (k === "finding") continue;
    if (prev[k] !== next[k]) return true;
  }
  return false;
}

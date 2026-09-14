// Extracted from App.svelte's fillMissingRanges (W79 phase 3b). Eligibility mirrors MarkersTab.svelte's
// translateAll: a resolvable, non-empty unit in client.results, first-seen-unit-wins per marker, and no
// existing personalized range yet (fill-missing, not force-all).

import type { Client } from "./types";

export function eligibleMarkersForRangeFill(client: Client): string[] {
  const unitByMarker = new Map<string, string>();
  for (const r of client.results) {
    if (!unitByMarker.has(r.marker)) unitByMarker.set(r.marker, r.unit);
  }
  const eligible: string[] = [];
  for (const [marker, unit] of unitByMarker) {
    if (unit && !client.personalizedRanges?.[marker]) eligible.push(marker);
  }
  return eligible;
}

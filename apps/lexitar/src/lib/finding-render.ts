import type { Client } from "./types";

// The flat, dedup'd list of every marker the Finding recommends (across
// healthMarkers.recommended groups). Used by the ingest pipeline to seed the
// tracked-marker set for range generation.
export function recommendedNamesFromFinding(f: Client["finding"]): string[] {
  if (!f) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of f.healthMarkers.recommended ?? []) {
    for (const m of g.markers ?? []) {
      const name = m.name.trim();
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

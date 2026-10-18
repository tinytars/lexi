// Marker grouping shared by the on-screen Markers tab and the print document
// (FullReport). Pure: groups a client's results into source → group → marker
// sections with status. Moved verbatim from App.svelte during the W11 restructure.

import type { Client, MarkerResult } from "./types";
import { concernRank, currentZoneStatus, resolveRange, type ZoneStatus } from "@pablotech/akesi/ranges";
import { sortPinnedFirst } from "./pin-sort";

export type Marker = {
  name: string;
  group: string;
  source: string;
  rows: MarkerResult[];
  highlighted: boolean;
  recommended: boolean;
  status: ZoneStatus;
};

// Descending concern (danger→warn→safe→unknown), alphabetical within each (Part E). Generic so
// Marker Ratios (M74) can reuse it without adopting the full Marker shape.
export function concernThenName<T>(getStatus: (t: T) => ZoneStatus, getName: (t: T) => string) {
  return (a: T, b: T) => concernRank(getStatus(a)) - concernRank(getStatus(b)) || getName(a).localeCompare(getName(b));
}

const byConcernThenName = concernThenName<Marker>((m) => m.status, (m) => m.name);

// M74 — Starred → Red → Orange → Green → Other: a stable pin-first partition over the existing
// concern sort, so starring bubbles a marker within its own group instead of duplicating it into
// a separate Watchlist section.
// M102 Phase 2 — exported so MarkersTab can order a flat, source-combined list directly, with no
// Blood/Imaging split. W63 — the split model it replaced (bySource / markerGroups / countMarkers /
// SourceSection, and the compareSource ordering that served only them) is deleted: nothing had
// referenced any of it since M102, and marker-grid.ts's own comment already said callers went
// around it.
export function byPinnedThenConcern(markers: Marker[]): Marker[] {
  return sortPinnedFirst(markers.slice().sort(byConcernThenName), (m) => m.highlighted);
}


// One Marker per distinct name (rows/status/flags resolved), sorted by name. The
// flat form the System-Analysis views group over; groupsOnly() builds on it for the no-Finding
// fallback wall.
// W65 — the `windowYears` parameter is GONE, and its absence is the answer to the question W63 left
// open. The window is a per-chart ZOOM: it narrows each series (MarkerChart), never the set of
// markers listed. A marker is in this list because the record contains it, and a health record does
// not drop entries because the reader is looking at a shorter span — with the default window of one
// year (App.svelte:176) that would have silently hidden 23 of Alex's 372 markers on load, while the
// sidebar (which passed Infinity) went on listing every one of them.
//
// The parameter had been accepted and ignored since W63, which is worse than either answer: it read
// as load-bearing at four call sites, two of which passed Infinity specifically to "opt out" of a
// filter that did not exist.
export function flatMarkers(client: Client): Marker[] {
  const groups = new Map<string, MarkerResult[]>();
  for (const r of client.results) {
    if (!groups.has(r.marker)) groups.set(r.marker, []);
    groups.get(r.marker)!.push(r);
  }
  for (const rows of groups.values()) rows.sort((a, b) => a.date.localeCompare(b.date));

  const watch = new Set(client.watchlist);
  const recommended = new Set(client.recommended ?? []);
  const markers = [...groups.entries()].map(([name, rows]) => ({
    name,
    group: rows[0]?.group || "Other",
    source: rows[0]?.source || "Other",
    rows,
    highlighted: watch.has(name),
    recommended: recommended.has(name),
    status: currentZoneStatus(rows[rows.length - 1]?.value ?? null, resolveRange(name, client)),
  }));
  return byPinnedThenConcern(markers);
}

// W26 — marker name → body system, from the AI's client.markerGroups (first
// placement wins). Empty when no grouping exists yet; the caller falls back.
export function markerSystemIndex(client: Client): Map<string, string> {
  const idx = new Map<string, string>();
  for (const g of client.markerGroups?.groups ?? []) {
    for (const name of g.markers) if (!idx.has(name)) idx.set(name, g.group);
  }
  return idx;
}

export type GroupSection = { group: string; markers: Marker[] };

// M102 Phase 2 — the no-Finding-yet fallback wall, grouped by panel only (no Blood/Imaging
// source split), each group's markers pinned/concern-ordered same as every other marker list.
export function groupsOnly(client: Client): GroupSection[] {
  const byGroup = new Map<string, Marker[]>();
  for (const m of flatMarkers(client)) {
    if (!byGroup.has(m.group)) byGroup.set(m.group, []);
    byGroup.get(m.group)!.push(m);
  }
  return [...byGroup.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([group, markers]) => ({ group, markers: byPinnedThenConcern(markers) }));
}

export function countGroups(arr: GroupSection[]): number {
  let n = 0;
  for (const g of arr) n += g.markers.length;
  return n;
}

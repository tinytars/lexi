// W38 — the permalink URL grammar. Extends the W11 single-tab hash into a hierarchical,
// shareable address. M82 Phase 5 flattened it further: since section keys are now globally
// unique (Phase 1), the tab segment is redundant and dropped from the serialized hash — the
// grammar is #<client>/<section>[/<anchor>], with chat keeping its own literal "chat" segment
// (chat has no static SectionMeta, so its slot holds an opaque thread id instead of a section
// key). Back-compat below still parses pre-M82 links that carried a tab segment.
import { type Tab, isTab, TABS, DEFAULT_TAB } from "./nav";
import type { LeafRef } from "./types";
import { AI_SECTIONS, DOCTOR_SECTIONS, LABS_SECTIONS, APPOINTMENT_SECTIONS, ALL_SECTIONS, type SectionMeta } from "./report-sections";

export { type Tab, isTab };

/**
 * Narrows a structural `LeafRef` to a `Permalink`, at the UI boundary.
 *
 * W72 — `types.ts` declares `LeafRef` with `tab: string` so the type module (194 importers, and
 * destined for the brain package per docs/cross-app/06) carries no opinion about the app's tab set.
 * The app's navigation does have that opinion, so somewhere the widening has to be undone — here,
 * once, with a real check rather than a cast.
 *
 * An unrecognised tab falls back to the default rather than throwing: a stored note attachment is
 * patient data that may predate a tab rename, and refusing to render it would lose the reference
 * entirely. Falling back navigates somewhere sensible and keeps the card visible.
 */
export function asPermalink(ref: LeafRef): Permalink {
  const tab: Tab = isTab(ref.tab) ? ref.tab : DEFAULT_TAB;
  return { client: ref.client, tab, section: ref.section, anchor: ref.anchor };
}

export interface Permalink {
  client?: string;
  tab: Tab;
  section?: string;
  anchor?: string;
}

// The tab's sections, for a tab whose content is sectioned (ReportSections). Chat/Markers have
// no SectionMeta array of their own.
const TAB_SECTIONS: Partial<Record<Tab, SectionMeta[]>> = {
  ai: AI_SECTIONS,
  doctor: DOCTOR_SECTIONS,
  labs: LABS_SECTIONS,
  appointment: APPOINTMENT_SECTIONS,
};

// Section key -> owning tab, inverted from TAB_SECTIONS. Permalink.tab is kept on the type (it's
// still consumed by ~13 leaf-component "Chat about this" reference-card call sites), so parsing
// a section-only hash segment still needs to recover which tab owns it. Exported so in-app
// navigation (App.svelte's triggerSidebarAction) can resolve the same mapping when constructing a
// nav patch directly, without going through a hash string.
export const SECTION_TAB: Record<string, Tab> = Object.fromEntries(
  (Object.entries(TAB_SECTIONS) as [Tab, SectionMeta[]][]).flatMap(([tab, sections]) => sections.map((s) => [s.key, tab])),
);

const SECTION_KEYS = new Set(ALL_SECTIONS.map((s) => s.key));

// Pre-M82 links carried a tab segment. A legacy tab id appearing bare (not immediately followed
// by a real section-key segment) maps to a representative default section.
const LEGACY_TAB_DEFAULT: Record<string, string> = {
  labs: "markers",
  doctor: "treatment",
  appointment: "notes",
  ai: "analysis",
  chat: "chat",
};

// Parse a location.hash into a Permalink. New grammar: #<client>/<section>[/<anchor>], or
// #<client>/chat/<threadId>[/<anchor>]. Back-compat: a pre-M82 #<client>/<tab>/<section>... link
// is also accepted — a legacy tab id immediately followed by a real section-key segment drops the
// stale tab segment and resolves to that section; a bare legacy tab id (no following section) maps
// via LEGACY_TAB_DEFAULT. Returns null when no segment is a section key, "chat", or a legacy tab id.
export function parseHash(hash: string): Permalink | null {
  const raw = hash.replace(/^#/, "");
  if (!raw) return null;
  const segs = raw.split("/").filter((s) => s.length > 0).map(decodeURIComponent);
  const idx = segs.findIndex((s) => SECTION_KEYS.has(s) || isTab(s));
  if (idx < 0) return null;
  const seg = segs[idx];
  const client = idx > 0 ? segs[idx - 1] : undefined;

  if (seg === "chat") {
    return { client, tab: "chat", section: segs[idx + 1], anchor: segs[idx + 2] };
  }
  if (isTab(seg)) {
    // Back-compat: a legacy tab id (labs/doctor/appointment/ai) that predates the flat grammar.
    const next = segs[idx + 1];
    if (next && SECTION_KEYS.has(next)) {
      return { client, tab: SECTION_TAB[next], section: next, anchor: segs[idx + 2] };
    }
    return { client, tab: seg, section: LEGACY_TAB_DEFAULT[seg], anchor: undefined };
  }
  // New flat grammar: <client>/<section>[/<anchor>].
  return { client, tab: SECTION_TAB[seg], section: seg, anchor: segs[idx + 1] };
}

// Serialize a Permalink to a location.hash string (leading '#'). Without a client, deeper
// segments are patient-scoped so we only emit the bare tab (there's no client-less section
// equivalent). With a client, the tab segment is dropped in favor of the section — except chat,
// which keeps its literal "chat" segment since its section slot holds an opaque thread id, not a
// SectionMeta key.
export function toHash(pl: Permalink): string {
  const enc = encodeURIComponent;
  if (!pl.client) return "#" + pl.tab;
  const segs = [pl.client];
  if (pl.tab === "chat") segs.push("chat");
  if (pl.section) {
    segs.push(pl.section);
    if (pl.anchor) segs.push(pl.anchor);
  }
  return "#" + segs.map(enc).join("/");
}

// A human-readable label for a section key (or "chat", which has no SectionMeta of its own) — for
// a "copy link" affordance / reference card title. Shared by App.svelte's whole-tab HeadingAnchor
// and ReportSections.svelte's section-level one, so their wording stays in sync with each other
// and with the resolver. Falls back to the tab label for a whole-tab reference (no section chosen)
// — reachable when a caller builds a Permalink directly rather than via parseHash.
export function sectionLabel(key: string): string {
  if (key === "chat") return "Chat";
  const section = ALL_SECTIONS.find((s) => s.key === key);
  if (section) return section.label;
  return TABS.find((t) => t.id === key)?.label ?? key;
}

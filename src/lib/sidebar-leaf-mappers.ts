// W58 — small pure `{item} → SidebarLeafRow` mappers, one per section that needed a NEW
// per-item leaf shape for the sidebar's group-expand children (Reports/Notes/Study already
// return SidebarLeafRow[] natively — see sidebar-leaf-rows.ts — so they don't need one here).
// Each mirrors the exact anchor a search result for that item already scrolls to
// (search-index.ts), so a sidebar child and a search hit resolve to the same DOM element.
import type { Marker } from "./marker-grid";
import type { RatioView } from "./marker-ratios";
import type { TreatmentItem } from "./types";
import { markerAnchor, ratioAnchor, treatmentAnchor, ideaAnchor, explorationItemAnchor, questionAnchor, termAnchor, threadAnchor } from "./anchor";
import type { Thread } from "./chat-threads";
import type { SidebarLeafRow } from "@tinytars/frame/sidebar-rows";
import { itemRecordId } from "@pablotech/akesi-pil/item-registry";

// The Assistant's threads, so Chat's sidebar list is built the same way every other section's is.
// `domId` is set here and nowhere else: a thread row exists ONLY in the sidebar, so it owns its own
// anchor id, whereas every other section's anchor belongs to an element in the main panel.
export function threadLeaf(t: Thread): SidebarLeafRow {
  return { key: t.id, label: t.title, anchor: threadAnchor(t.id), pinned: t.pinned, domId: threadAnchor(t.id) };
}

// W62 — `pinned` comes from the caller because a marker's pin is watchlist membership and a ratio's
// is pinnedRatios: both live on the Client, not on the row, so a mapper over a bare Marker/RatioView
// cannot read it. The row's own key IS the record id for both (the name), so no itemId is needed.
export function markerLevelLeaf(m: Marker, pinned?: boolean): SidebarLeafRow {
  return { key: m.name, label: m.name, anchor: markerAnchor(m.name), pinned };
}

export function markerRatioLeaf(rv: RatioView, pinned?: boolean): SidebarLeafRow {
  return { key: rv.ratio.name, label: rv.ratio.name, anchor: ratioAnchor(rv.ratio.name), pinned };
}

export function treatmentLeaf(t: TreatmentItem): SidebarLeafRow {
  return { key: t.id, label: t.name, anchor: treatmentAnchor(t.name), pinned: t.pinned };
}

// M103 — one leaf per distinct drug name for the Medicine audit view (see groupByName in
// treatment-bucket.ts), not one per raw row. Shares treatmentAnchor(name) with `treatmentLeaf` and
// with each raw row's own HeadingAnchor — same anchor collision across a drug's titration rows that
// already exists today, now also the group heading's anchor, which is the more useful landing spot.
export function medicineNameLeaf(g: { name: string; rows?: { pinned?: boolean }[] }): SidebarLeafRow {
  // A medicine is pinned when any of its dose rows is — UnifiedTreatment's togglePinMedicine flags
  // rows[0], but a row pinned individually should float its drug up here too.
  return { key: g.name, label: g.name, anchor: treatmentAnchor(g.name), pinned: g.rows?.some((r) => r.pinned) };
}

// `index` is positional and part of the anchor, so it must stay the item's ORIGINAL index —
// pinned-first sorting happens on the mapped leaves, never on the source array.
export function ideaLeaf(
  topic: string,
  side: "patient" | "ai",
  index: number,
  label: string,
  opts?: { pinned?: boolean; itemId?: string | null },
): SidebarLeafRow {
  return {
    key: `${topic}-${side}-${index}`,
    label,
    anchor: ideaAnchor(topic, side, index),
    pinned: opts?.pinned,
    // A patient idea IS a DecisionEntry, so it can be pinned; an AI-proposed one has no record at
    // all. Without this the sidebar pinned a key like "Lipids-patient-0", which matches no item and
    // silently did nothing.
    itemId: opts?.itemId,
  };
}

// W62 — the four generated sections. Their keys are POSITIONAL (the anchor needs the index) but the
// next Finding renumbers everything, so the record id is keyed on the item's own text instead —
// see item-registry.ts. `pinned` is supplied by the builder, which has the Client to read it from.
export function explorationItemLeaf(group: string | undefined, type: string, side: "items" | "dueSoon", index: number, item: string, pinned?: boolean): SidebarLeafRow {
  return {
    key: `${group ?? ""}-${type}-${side}-${index}`,
    label: item,
    anchor: explorationItemAnchor(group, type, side, index),
    itemId: itemRecordId("exploration", item),
    pinned,
  };
}

export function questionLeaf(group: string, index: number, q: string, pinned?: boolean): SidebarLeafRow {
  return {
    key: `${group}-${index}`,
    label: q.length > 60 ? q.slice(0, 60) + "…" : q,
    anchor: questionAnchor(group, index),
    searchText: q,
    // The FULL question, not the truncated label — two questions sharing a 60-char prefix are
    // different areas of query and must not share a pin.
    itemId: itemRecordId("question", q),
    pinned,
  };
}

export function termLeaf(d: { term: string }, pinned?: boolean): SidebarLeafRow {
  return { key: d.term, label: d.term, anchor: termAnchor(d.term), itemId: itemRecordId("glossary", d.term), pinned };
}

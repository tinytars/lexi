// Pin / rename / delete for one vault item, as PURE functions over a Client.
//
// These exist because the sidebar now offers per-row actions and the sidebar has no access to the
// body components where those mutations used to live: there are six near-identical
// clone-mutate-persist pin toggles today (Notes.svelte:223, Study.svelte:145, Allergies.svelte:131,
// Family.svelte:130, UnifiedTreatment.svelte:360, FutureTreatment.svelte:159). Rather than add a
// seventh copy per surface, the mutation is a pure function here and App.svelte applies it through
// its existing saveEdits() path — the same shape toggleChatThreadPin already uses.
//
// Pure means unit-testable without a vault, a DEK or a component, which is the point: these touch
// user-entered patient data, where "never lose it" is the standing rule.
import type { AllergyEntry, Client, DecisionEntry, FamilyHistoryEntry, NoteEntry, StudyEntry, TreatmentItem } from "./types";
import { toggleItemPin, isItemPinned } from "@pablotech/akesi-pil/item-registry";
import { labelSubject } from "./leaf-regen-registry";
import { entityForSidebarKind } from "./entity-kinds";

// W62 — the kinds below the divider have no writable-list record of their own, so each dispatches
// to where its pin ALREADY lives rather than growing a parallel one:
//   report  → SourceRecord.pinned (a report is the one generated-adjacent section with a real record)
//   marker  → client.watchlist    (tracking a marker IS pinning it — the app has always had one bit)
//   ratio   → client.pinnedRatios (M74's separate star, kept separate)
//   the rest→ client.itemRegistry (item-registry.ts, keyed by the item's text)
// Routing them through this one function is what lets Sidebar/App stay unaware of the difference.
export type SidebarItemKind =
  | "note" | "study" | "allergy" | "family" | "decision" | "treatment" | "medicine"
  | "report" | "marker" | "ratio"
  | "question" | "glossary" | "exploration" | "analysis" | "recommendedMarkers";

const GENERATED_KINDS = ["question", "glossary", "exploration", "analysis", "recommendedMarkers"] as const;

function isGenerated(kind: SidebarItemKind): boolean {
  return (GENERATED_KINDS as readonly string[]).includes(kind);
}

/** Membership-list pin (watchlist / pinnedRatios), absent-when-empty on both sides. */
function toggleMembership(client: Client, field: "watchlist" | "pinnedRatios", name: string): Client {
  const prior = client[field] ?? [];
  const next = prior.includes(name) ? prior.filter((n) => n !== name) : [...prior, name];
  return { ...client, [field]: next };
}

/** The field a Rename edits, per kind. Absent = this kind has no writable label (see the comment
 *  on each: a note is free text; a treatment/medicine name is the Finding's matching key). */
const RENAME_FIELD: Partial<Record<SidebarItemKind, string>> = {
  study: "focus",
  allergy: "allergen",
  family: "relation",
  decision: "intervention",
};

export function renameFieldFor(kind: SidebarItemKind): string | undefined {
  return RENAME_FIELD[kind];
}

type AnyItem = NoteEntry | StudyEntry | AllergyEntry | FamilyHistoryEntry | DecisionEntry | TreatmentItem;

/** Reads the list a kind lives in, and writes a replacement back, without mutating `client`. */
function withList(client: Client, kind: SidebarItemKind, fn: (list: AnyItem[]) => AnyItem[]): Client {
  const factors = client.factors ?? {};
  switch (kind) {
    case "note":
      return { ...client, factors: { ...factors, noteEntries: fn(factors.noteEntries ?? []) as NoteEntry[] } };
    case "allergy":
      return { ...client, factors: { ...factors, allergies: fn(factors.allergies ?? []) as AllergyEntry[] } };
    case "family":
      return { ...client, factors: { ...factors, familyHistory: fn(factors.familyHistory ?? []) as FamilyHistoryEntry[] } };
    case "decision":
      return { ...client, factors: { ...factors, decisions: fn(factors.decisions ?? []) as DecisionEntry[] } };
    case "treatment":
    case "medicine":
      return { ...client, factors: { ...factors, treatments: fn(factors.treatments ?? []) as TreatmentItem[] } };
    case "study":
      return { ...client, study: { ...client.study, entries: fn(client.study?.entries ?? []) as StudyEntry[] } };
    // The kinds above the divider in SidebarItemKind are the list-backed ones. The rest (report,
    // marker, ratio, and the generated kinds) keep their pin somewhere else entirely and never
    // reach here — their callers dispatch first, and rename/label gate on RENAME_FIELD. Returning
    // the client untouched keeps this total rather than leaving a kind with no branch.
    default:
      return client;
  }
}

/**
 * `id` is the item's own id — except for "medicine", where it is the drug NAME, because a medicine
 * row in the sidebar stands for every dose row sharing that name. Pinning one pins the whole drug,
 * which is what makes medicineNameLeaf's `rows.some(pinned)` read round-trip.
 */
export function togglePinnedIn(client: Client, kind: SidebarItemKind, id: string): Client {
  if (isGenerated(kind)) return toggleItemPin(client, id);
  if (kind === "marker") return toggleMembership(client, "watchlist", id);
  if (kind === "ratio") return toggleMembership(client, "pinnedRatios", id);
  if (kind === "report") {
    return { ...client, sources: (client.sources ?? []).map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s)) };
  }
  if (kind === "medicine") {
    const name = id.trim().toLowerCase();
    const rows = (client.factors?.treatments ?? []).filter((t) => t.name.trim().toLowerCase() === name);
    const next = !rows.some((t) => t.pinned);
    return withList(client, kind, (list) =>
      (list as TreatmentItem[]).map((t) => (t.name.trim().toLowerCase() === name ? { ...t, pinned: next } : t)),
    );
  }
  return withList(client, kind, (list) => list.map((it) => (it.id === id ? { ...it, pinned: !it.pinned } : it)));
}

/** No-ops on an empty/whitespace name rather than blanking the label — same rule as commitChatRename. */
export function renameIn(client: Client, kind: SidebarItemKind, id: string, text: string): Client {
  const field = RENAME_FIELD[kind];
  const trimmed = text.trim();
  if (!field || !trimmed) return client;
  return withList(client, kind, (list) =>
    list.map((it) => (it.id === id ? ({ ...it, [field]: trimmed } as AnyItem) : it)),
  );
}

export function removeFrom(client: Client, kind: SidebarItemKind, id: string): Client {
  // A medicine row stands for a whole dose history; deleting it from a sidebar row would remove
  // several records at once, so it is deliberately not offered (sidebar-row-capabilities.ts).
  if (kind === "medicine") return client;
  // Deleting a generated item would be deleting a line of the Finding, which the next regeneration
  // writes straight back; deleting a report means expunging its raw file and every reading it
  // produced (the removedSources tombstone flow), far too heavy for a row menu. Neither offers
  // Delete in the capabilities table — this guard is the second lock, not the first.
  if (isGenerated(kind) || kind === "report" || kind === "marker" || kind === "ratio") return client;
  const removed = withList(client, kind, (list) => list.filter((it) => it.id !== id));
  // W68 — and take the AI's turn ABOUT that row with it. Deleting a row used to leave its generated
  // content behind forever: no merge ever removes an entry (mergeLabeledItems deliberately keeps an
  // existing one with no returned counterpart, so a scoped regen cannot wipe its siblings), and no
  // caller pruned. Found by running finding-invariants.ts against the live vault, which reported two
  // assessments for treatments Pablo deleted months ago.
  return pruneFindingFor(removed, client, kind, id);
}

/**
 * Drop the Finding entries that were about a row that has just been deleted.
 *
 * `before` is the client as it was, so a name-keyed section can still read the label it must match;
 * `after` is the pruned one. A name-keyed section is only pruned when NO remaining row shares the
 * subject — deleting one dose period of a drug that still has others must not take the drug's
 * assessment with it.
 */
function pruneFindingFor(after: Client, before: Client, kind: SidebarItemKind, id: string): Client {
  const f = after.finding;
  if (!f) return after;

  // W70 — derived from ENTITY_KINDS, not restated. These two maps used to be written here by hand and
  // covered three kinds, while finding-invariants' ID_KEYED covered four; the disagreement is what let
  // a deleted report orphan every diagnosis read it carried. One table, one truth.
  const entity = entityForSidebarKind(kind);
  if (entity) {
    const rows = f[entity.resultSection] as { [k: string]: string }[] | undefined;
    if (!rows) return after;
    return { ...after, finding: { ...f, [entity.resultSection]: rows.filter((r) => r[entity.idField] !== id) } };
  }

  // labelOf reads RENAME_FIELD, which has no `treatment` entry (a treatment is not renamed from a
  // sidebar row), so the name is read off the row itself.
  const label =
    kind === "treatment"
      ? ((before.factors?.treatments ?? []).find((t) => t.id === id)?.name ?? "").trim()
      : labelOf(before, kind, id).trim();
  if (!label) return after;

  if (kind === "treatment") {
    const subject = labelSubject(label);
    // Another dose period of the same drug still on file → its assessment is still about something.
    const stillThere = (after.factors?.treatments ?? []).some((t) => labelSubject(t.name) === subject);
    if (stillThere) return after;
    return {
      ...after,
      finding: {
        ...f,
        treatment: (f.treatment ?? []).filter((e) => labelSubject(e.item) !== subject),
        planAssessmentRows: (f.planAssessmentRows ?? []).filter((r) => labelSubject(r.action) !== subject),
      },
    };
  }

  if (kind === "study") {
    return { ...after, finding: { ...f, studyResults: (f.studyResults ?? []).filter((r) => r.study.trim() !== label) } };
  }

  if (kind === "decision") {
    return {
      ...after,
      finding: {
        ...f,
        decisions: { ai: f.decisions?.ai ?? [], patient: (f.decisions?.patient ?? []).filter((d) => d.intervention.trim() !== label) },
        // Its doctor-conversation group goes too, or the patient band names an idea that is gone.
        doctorConversation: (f.doctorConversation ?? []).filter((g) => g.group.trim() !== label),
      },
    };
  }
  return after;
}

/** The current label of an item, for seeding an inline rename. */
export function labelOf(client: Client, kind: SidebarItemKind, id: string): string {
  const field = RENAME_FIELD[kind];
  if (!field) return "";
  let found = "";
  withList(client, kind, (list) => {
    const hit = list.find((it) => it.id === id) as Record<string, unknown> | undefined;
    found = typeof hit?.[field] === "string" ? (hit[field] as string) : "";
    return list;
  });
  return found;
}

/** Is this row pinned? The read side of togglePinnedIn, for the kinds whose pin is not a boolean
 *  on the row itself. */
export function isPinnedIn(client: Client, kind: SidebarItemKind, id: string): boolean {
  if (isGenerated(kind)) return isItemPinned(client, id);
  if (kind === "marker") return (client.watchlist ?? []).includes(id);
  if (kind === "ratio") return (client.pinnedRatios ?? []).includes(id);
  if (kind === "report") return !!(client.sources ?? []).find((s) => s.id === id)?.pinned;
  return false;
}

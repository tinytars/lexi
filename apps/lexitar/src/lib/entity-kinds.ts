import type { ClientFactors, ClientFinding } from "./types";
import type { SidebarItemKind } from "./vault-item-ops";

// W70 Phase 4 — one place that knows the patient-entered entity kinds.
//
// Adding an entity kind (allergies and family history were the last, in M65: 25 files, +862/-298)
// means roughly THIRTY registration points across ~26 non-test files, of which exactly three are
// backed by a mechanical check. Everything else is convention: miss one and nothing fails, the
// symptom is a row that never appears in search, or a Finding entry keyed to a row that no longer
// exists — invisible in the UI, travelling in the vault forever.
//
// The concrete cost of that, found while planning this milestone: FOUR separate tables encoded the
// same few-entity fact, and they already disagreed. `vault-item-ops`' delete cascade covered three
// kinds; `finding-invariants`' ID_KEYED covered four. Deleting a clinical report therefore orphaned
// the AI's read of every diagnosis it carried, because the one table that would have said so was the
// one the cascade did not consult. That was a real defect, fixed separately in this milestone — and
// it is the argument for this file.
//
// What makes this a REGISTRY rather than a fifth table: the field types are keyed to the real shapes.
// `source` must name an actual ClientFactors list; `resultSection` must name an actual ClientFinding
// section. A kind that misspells either, or that is added without one, does not typecheck — so
// `npm run check`, already a hosted CI step, becomes the mechanical check the entity axis never had.
//
// Deliberately NOT here: display order, labels, icons and blurbs (report-sections.ts owns those and
// they are human copy, not table rows), the Svelte editors, the leaf specs, the DAG nodes and the
// prompt text. This collapses roughly 8-12 of the ~30 points and converts about 5 more from silent
// omission to compile error. It does not reach 30 and should not claim to.

export interface EntitySpec {
  /**
   * The sidebar item kind, i.e. what `removeFrom`/`renameIn` are called with.
   *
   * OPTIONAL, and that is the point: a diagnosis has no sidebar kind, because it is removed with the
   * report that produced it (report-merge.ts's removeSource), never from a row menu. Expressing that
   * in the type is why `disease` needs no cast — an earlier draft wrote `"disease" as SidebarItemKind`
   * and a comment, which is the same asymmetry restated as a lie the compiler cannot check.
   */
  readonly sidebarKind?: SidebarItemKind;
  /** The `factors` list the patient's own rows live in. */
  readonly source: keyof ClientFactors;
  /** The Finding section carrying the AI's read of those rows. */
  readonly resultSection: keyof ClientFinding;
  /** The field in that section echoing the row's id. */
  readonly idField: string;
}

/**
 * The four kinds whose rows the patient enters and the Finding answers one-for-one.
 *
 * `satisfies` rather than a plain annotation, so each entry keeps its literal types (callers can
 * still narrow on `"noteResults"`) while the shape is still checked.
 */
export const ENTITY_KINDS = {
  note: { sidebarKind: "note", source: "noteEntries", resultSection: "noteResults", idField: "noteId" },
  allergy: { sidebarKind: "allergy", source: "allergies", resultSection: "allergyResults", idField: "allergyId" },
  family: { sidebarKind: "family", source: "familyHistory", resultSection: "familyResults", idField: "familyId" },
  disease: { source: "diseases", resultSection: "diseaseResults", idField: "diseaseId" }, // no sidebarKind: see above
} as const satisfies Record<string, EntitySpec>;

export type EntityKind = keyof typeof ENTITY_KINDS;

export const ENTITY_SPECS: readonly EntitySpec[] = Object.values(ENTITY_KINDS);

/**
 * The spec for a sidebar kind, or undefined when that kind is not deletable from a row.
 *
 * The delete cascade therefore covers three kinds while the invariants cover four — real and intended.
 * It was the UNDOCUMENTED version of that asymmetry, spread across two hand-written tables that
 * disagreed, which orphaned every diagnosis read when a report was deleted.
 */
export function entityForSidebarKind(kind: SidebarItemKind): EntitySpec | undefined {
  return ENTITY_SPECS.find((e) => e.sidebarKind === kind);
}

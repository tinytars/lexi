// Extracted from UnifiedTreatment.svelte's hasAnyDose/editIndexOf (W79 phase 4a) — small pure lookups
// over the in-progress draft's treatment rows.

import type { TreatmentItem } from "./types";
import { matchesTreatmentName } from "./treatment-name-match";

export function hasAnyDose(name: string, treatments: TreatmentItem[] | undefined): boolean {
  return (treatments ?? []).some((x) => matchesTreatmentName(x.name, name) && x.doseAmount != null);
}

export function editIndexOf(id: string, treatments: TreatmentItem[] | undefined): number {
  return treatments?.findIndex((x) => x.id === id) ?? -1;
}

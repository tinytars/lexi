// Extracted from UnifiedTreatment.svelte's saveNewTreatment (W79 phase 4b) — reason is medicine-level
// by convention even though it's edited in the per-dose form, so every save fans it out to sibling
// rows of the same drug (skipping the row just saved, which already has it).

import type { TreatmentItem } from "./types";

export function fanoutReason(
  rows: TreatmentItem[] | undefined,
  savedId: string,
  savedNameLower: string,
  reason: string | undefined,
): void {
  for (const x of rows ?? []) {
    if (x.id === savedId) continue;
    if (x.name.trim().toLowerCase() !== savedNameLower) continue;
    x.reason = reason;
  }
}

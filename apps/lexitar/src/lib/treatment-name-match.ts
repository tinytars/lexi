// Extracted from UnifiedTreatment.svelte (W79 phase 4a) — the trim/lowercase normalization used to
// match treatment rows by name (attachToTreatment's row mirroring, hasAnyDose's lookup), rather than
// by id, since a dose is entered as a separate row per titration step under one drug name.

export function normalizeTreatmentName(name: string): string {
  return name.trim().toLowerCase();
}

export function matchesTreatmentName(a: string, b: string): boolean {
  return normalizeTreatmentName(a) === normalizeTreatmentName(b);
}

// Extracted from UnifiedTreatment.svelte's identifyFrom (W79 phase 4a). The per-field merge of an
// AI-inferred result into the in-progress draft, as a pure patch builder — the async inference call,
// error handling, and pendingImages bookkeeping stay in the component.

import type { TreatmentItem } from "./types";
import type { ProposedTreatment } from "@pablotech/akesi/treatment-infer";

export function mergeInferredFields(
  result: ProposedTreatment,
  source: "photos" | "text",
  rawText: string,
): Partial<TreatmentItem> {
  const patch: Partial<TreatmentItem> = {
    name: result.name,
    kind: result.kind,
  };
  if (result.description) patch.description = result.description;
  if (result.maker) patch.maker = result.maker;
  if (result.ingredients?.length) patch.ingredients = result.ingredients;
  if (result.links?.length) patch.links = result.links;
  // Turn 2's inference locks turn 3's unit — the patient supplies a COUNT of this same unit,
  // never a different one (treatmentFields renders doseUnit read-only once this is set).
  if (result.administration) {
    patch.administration = result.administration;
    patch.doseUnit = result.administration.unit;
  }
  // Provenance: this record's product fields just came from LexiTar reading a raw source, not
  // from typing — see TreatmentItem.extracted. For text, the raw source itself is captured too:
  // the pasted string IS the raw source, kept verbatim. For a photo, the raw source is captured by
  // the caller marking which pendingImages produced this run (not part of this patch).
  patch.extracted = { via: source === "photos" ? "photo" : "text", at: new Date().toISOString() };
  if (source === "text") patch.rawCaptureText = rawText.trim();
  return patch;
}

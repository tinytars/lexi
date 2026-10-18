import type { Client, ClientFactors, LegacyFactors } from "./types";
import { normalizeTreatments } from "@pablotech/akesi/treatment-normalize";
import { endOfMonth } from "@pablotech/akesi/dates";

export function foldLegacyTreatments(c: Client): Client {
  c.factors ??= {};
  c.factors.treatments ??= normalizeTreatments(c.factors as ClientFactors & LegacyFactors);
  return c;
}

export function dropLegacyTreatmentFields(c: Client): Client {
  const legacy = (c.factors ?? {}) as Partial<LegacyFactors>;
  delete legacy.medications;
  delete legacy.supplements;
  delete legacy.plan;
  return c;
}

// A type="date" input can't render a bare "YYYY-MM"; normalizeClientDraft applies the same coercion,
// so the baseline matches and this doesn't read as an unsaved change on load.
export function treatmentEditDraft(c: Client): Client {
  for (const t of foldLegacyTreatments(c).factors!.treatments!) {
    if (t.start) t.start = endOfMonth(t.start);
    if (t.end) t.end = endOfMonth(t.end);
  }
  return dropLegacyTreatmentFields(c);
}

import type { DecisionEntry, DiseaseEntry, StudyEntry, TreatmentItem, TreatmentKind } from "../src/lib/types";
import { normalizeDate } from "@pablotech/akesi/treatment-normalize";

const TREATMENT_KINDS: TreatmentKind[] = ["drug", "supplement", "behavior"];

// W63 — these parse CONTENT off a CLI flag; the id and the pin are minted by the adder that
// consumes them (factors.ts's addTreatment/addDecision, factors-edit.ts's addDisease, and
// ingest.ts's addStudies branch), never here. `Omit<…, "id" | "pinned">` is the same shape
// factors-edit.ts:16's addDisease already declares — typing them as the full entity claimed an id
// that does not exist yet, which is only invisible while nothing type-checks scripts/.
type Draft<T> = Omit<T, "id" | "pinned">;

export function parseStudy(raw: string, flag: string): Draft<StudyEntry> {
  const idx = raw.indexOf("|");
  if (idx <= 0) {
    throw new Error(`${flag} expects "Focus|Detail", got "${raw}"`);
  }
  const focus = raw.slice(0, idx).trim();
  const detail = raw.slice(idx + 1).trim();
  if (!focus || !detail) {
    throw new Error(`${flag} expects "Focus|Detail", got "${raw}"`);
  }
  return { focus, detail };
}

export function parseTreatment(raw: string, flag: string): Draft<TreatmentItem> {
  const parts = raw.split("|").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 5 || !parts[0]) {
    throw new Error(`${flag} expects "Name|Dose|Kind|Start|End" (Dose/Kind/End optional), got "${raw}"`);
  }
  const [name, dose, kind, start, end] = parts;
  if (kind && !TREATMENT_KINDS.includes(kind as TreatmentKind)) {
    throw new Error(`${flag} kind must be one of ${TREATMENT_KINDS.join("/")}, got "${kind}"`);
  }
  const t: Draft<TreatmentItem> = { name, start: normalizeDate(start ?? "") };
  if (dose) t.dose = dose;
  if (kind) t.kind = kind as TreatmentKind;
  const e = normalizeDate(end ?? "");
  if (e) t.end = e;
  return t;
}

export function parseDisease(raw: string, flag: string): Draft<DiseaseEntry> {
  const idx = raw.indexOf("|");
  if (idx <= 0) {
    throw new Error(`${flag} expects "Date|Diagnostic", got "${raw}"`);
  }
  const date = raw.slice(0, idx).trim();
  const diagnostic = raw.slice(idx + 1).trim();
  if (!date || !diagnostic) {
    throw new Error(`${flag} expects "Date|Diagnostic", got "${raw}"`);
  }
  return { date, diagnostic };
}

export function parseDecision(raw: string, flag: string): Draft<DecisionEntry> {
  const idx = raw.indexOf("|");
  if (idx <= 0) {
    throw new Error(`${flag} expects "Intervention|Purpose", got "${raw}"`);
  }
  const intervention = raw.slice(0, idx).trim();
  const purpose = raw.slice(idx + 1).trim();
  if (!intervention || !purpose) {
    throw new Error(`${flag} expects "Intervention|Purpose", got "${raw}"`);
  }
  return { intervention, purpose };
}

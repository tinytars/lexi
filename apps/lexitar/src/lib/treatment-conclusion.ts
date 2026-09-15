// Turn 4 — the computed conclusion: what the patient is ACTUALLY taking per day, in the
// ingredient's own clinical unit, not the countable-unit count ("6 fish oils" means nothing to an
// ER doctor; "4g/day of omega-3" does). Pure arithmetic on already-structured data (turn 2's
// administration + turn 3's patient dose) — no LLM call, so it can never hallucinate a number.
// Refuses to answer rather than guess when the inputs don't support a real total.
import type { Administration, DoseFrequency, Ingredient, TreatmentItem } from "./types";
import { bucketOf, groupByName } from "@pablotech/akesi/treatment-bucket";

export interface IngredientTotal {
  name: string;
  amountPerDay: number;
  unit: string;
  form?: string;
}

export interface Conclusion {
  totalUnitsPerDay: number;
  unit: string;
  ingredientTotals: IngredientTotal[];
}

export type ConclusionRefusal =
  | { reason: "no-administration" }
  | { reason: "no-patient-dose" }
  | { reason: "unit-mismatch"; patientUnit: string; labelUnit: string }
  | { reason: "as-needed" };

export function isConclusion(x: Conclusion | ConclusionRefusal): x is Conclusion {
  return "totalUnitsPerDay" in x;
}

// Only "as-needed" gets an explanatory line. Every other refusal means turn 2/3 simply haven't
// happened yet (or, for a unit mismatch, a legacy hand-edited row disagrees with its own locked
// unit) — a normal, silent "not applicable yet," not something worth surfacing as text.
export function conclusionMessage(r: ConclusionRefusal): string | null {
  return r.reason === "as-needed" ? "Dosed as needed — no daily total." : null;
}

function administrationsPerDay(freq: DoseFrequency | undefined): number | null {
  if (freq === "day") return 1;
  if (freq === "week") return 1 / 7;
  if (freq === "month") return 1 / 30; // approximation — a calendar month has no fixed day count
  return null; // "as needed", or unset — no fixed daily rate, ever
}

/** Rounds for display without pretending the arithmetic is more precise than it is. */
export function roundAmount(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatIngredientTotal(t: IngredientTotal): string {
  return `${roundAmount(t.amountPerDay)}${t.unit}/day ${t.name}${t.form ? ` (${t.form})` : ""}`;
}

// `ongoingRows` = every CURRENTLY-ongoing row of ONE medicine (groupByName + bucketOf==="ongoing").
// An AM row and a PM row of the same drug are both ongoing at once (treatment-bucket.ts's
// splitByTiming precedent) and BOTH must contribute, or a twice-daily regimen is undercounted by
// half. `administration`/`ingredients` are medicine-level (identical across a drug's rows) — pass
// the group's own values, not any one row's.
export function computeConclusion(
  ongoingRows: Pick<TreatmentItem, "doseAmount" | "doseUnit" | "doseFrequency">[],
  administration: Administration | undefined,
  ingredients: Ingredient[] | undefined,
): Conclusion | ConclusionRefusal {
  if (!administration) return { reason: "no-administration" };
  if (ongoingRows.length === 0 || ongoingRows.some((r) => r.doseAmount == null)) {
    return { reason: "no-patient-dose" };
  }
  const mismatched = ongoingRows.find(
    (r) => (r.doseUnit ?? "").trim().toLowerCase() !== administration.unit.trim().toLowerCase(),
  );
  if (mismatched) {
    return { reason: "unit-mismatch", patientUnit: mismatched.doseUnit ?? "", labelUnit: administration.unit };
  }

  let totalUnitsPerDay = 0;
  for (const row of ongoingRows) {
    const perDay = administrationsPerDay(row.doseFrequency);
    if (perDay == null) return { reason: "as-needed" };
    totalUnitsPerDay += row.doseAmount! * perDay;
  }

  const servingsPerDay = totalUnitsPerDay / administration.unitsPerServing;
  const ingredientTotals: IngredientTotal[] = (ingredients ?? [])
    .filter((i) => i.amount != null)
    .map((i) => ({ name: i.name, amountPerDay: i.amount! * servingsPerDay, unit: i.unit ?? "", form: i.form }));

  return { totalUnitsPerDay, unit: administration.unit, ingredientTotals };
}

// Every currently-ongoing medicine's computed daily ingredient total, keyed by the medicine's
// normalized (trimmed, lowercased) name — the groupByName + bucketOf + computeConclusion join,
// factored out so chat-context.ts and leaf-regen-registry.ts (Finding generation) don't each
// reimplement the same "which rows are concurrently ongoing" arithmetic.
export function dailyTotalsByName(items: TreatmentItem[], today: string): Map<string, IngredientTotal[]> {
  const totals = new Map<string, IngredientTotal[]>();
  for (const group of groupByName(items, today)) {
    const ongoingRows = group.rows.filter((r) => bucketOf(r, today) === "ongoing");
    if (!ongoingRows.length) continue;
    const conclusion = computeConclusion(ongoingRows, group.rows[0].administration, group.rows[0].ingredients);
    if (isConclusion(conclusion) && conclusion.ingredientTotals.length) {
      totals.set(group.name.trim().toLowerCase(), conclusion.ingredientTotals);
    }
  }
  return totals;
}

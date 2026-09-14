import { describe, it, expect } from "vitest";
import { addTreatment, addDisease, addDecision } from "../../scripts/factors";
import { normalizeClientDraft } from "@pablotech/akesi-pil/factors-edit";
import { nodeInputCanonical } from "../../src/lib/node-input-hash";
import type { Client } from "../../src/lib/types";

// M67 Phase 2c — the general safeguard for the root-caused bug: a Finding's nodeHashes are stamped
// from CLI-authored data (scripts/factors.ts's add* verbs); the browser later recomputes the same
// hashes from whatever normalizeClientDraft (src/lib/factors-edit.ts) produces on the very first web
// save. If those two paths ever normalize a field differently, that field (and anything downstream
// of it in the DAG) goes permanently "stale" with no user-visible error — this is exactly what broke
// per-item leaf-regen in production (docs/plans/67-study-modal-and-leaf-regen-trigger-fix.md).
// Asserting normalizeClientDraft is a no-op on CLI-authored data catches this class of bug directly,
// independent of which specific field regresses next.

function baseClient(): Client {
  return { displayName: "Test", dob: "1980-01-01", gender: "male", watchlist: [], results: [], factors: {} };
}

describe("normalizeClientDraft is a no-op on CLI-authored data (M67 Phase 2c regression guard)", () => {
  it("treatmentHistory / patientPlan canonical hash is unchanged after a save-round-trip", () => {
    const a = baseClient();
    addTreatment(a, { name: "Enclomiphene", dose: "12.5mg", kind: "drug", start: "2026-01" });
    addTreatment(a, { name: "Tirzepatide", dose: "6mg/week", kind: "drug", start: "2025-08", end: "2025-12" });

    const beforeHistory = nodeInputCanonical(a, "treatmentHistory");
    const beforePlan = nodeInputCanonical(a, "patientPlan");

    const saved = normalizeClientDraft(a);

    expect(nodeInputCanonical(saved, "treatmentHistory")).toBe(beforeHistory);
    expect(nodeInputCanonical(saved, "patientPlan")).toBe(beforePlan);
  });

  it("diagnosedDisease canonical hash is unchanged after a save-round-trip", () => {
    const a = baseClient();
    addDisease(a, { date: "2024-01", diagnostic: "Hyperlipidemia" });

    const before = nodeInputCanonical(a, "diagnosedDisease");
    const saved = normalizeClientDraft(a);

    expect(nodeInputCanonical(saved, "diagnosedDisease")).toBe(before);
  });

  it("patientAssessment / patientHypothesis canonical hash is unchanged after a save-round-trip", () => {
    const a = baseClient();
    addDecision(a, { intervention: "TRT", purpose: "improved free T" });

    const beforeAssessment = nodeInputCanonical(a, "patientAssessment");
    const beforeHypothesis = nodeInputCanonical(a, "patientHypothesis");

    const saved = normalizeClientDraft(a);

    expect(nodeInputCanonical(saved, "patientAssessment")).toBe(beforeAssessment);
    expect(nodeInputCanonical(saved, "patientHypothesis")).toBe(beforeHypothesis);
  });
});

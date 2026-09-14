import { describe, it, expect } from "vitest";
import { resolvePatientRef, resolveAiRef, resolveTreatmentGroups, buildHypothesisGroups } from "../../src/lib/treatment-groups";
import { UNCATEGORIZED } from "@pablotech/akesi-pil/system-groups";
import type { Client } from "../../src/lib/types";

function client(_extra: Partial<Client> = {}): Client {
  return {
    displayName: "Pablo",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    factors: {
      decisions: [{ id: "dec-1", intervention: "Methylation stack", purpose: "Improve overnight HRV" }],
      treatments: [{ id: "trt-1", name: "Start statin or statin-like approach", kind: "behavior", start: "2099-06" }],
    },
    finding: {
      decisions: {
        patient: [],
        ai: [
          { intervention: "Rosuvastatin", purpose: "Cut ApoB", pros: [], cons: [], alternatives: [], recommendation: "" },
          { intervention: "PCSK9 inhibitor", purpose: "Escalation", pros: [], cons: [], alternatives: [], recommendation: "" },
        ],
      },
      treatmentGroups: [
        { system: "Cardiovascular Risk", topic: "Lipid-lowering", patient: ["Start statin or statin-like approach"], ai: ["Rosuvastatin", "PCSK9 inhibitor"] },
        { system: "Methylation / Nutrient Status", topic: "Methyl donors", patient: ["Methylation stack"], ai: [] },
      ],
    },
  } as unknown as Client;
}

describe("treatment-groups resolver", () => {
  it("resolves a patient ref to a decision (kind + purpose)", () => {
    expect(resolvePatientRef(client(), "Methylation stack")).toEqual({
      kind: "decision", id: "dec-1", pinned: false, label: "Methylation stack", purpose: "Improve overnight HRV",
    });
  });

  it("resolves a patient ref to a planned treatment (kind + start date)", () => {
    expect(resolvePatientRef(client(), "Start statin or statin-like approach")).toEqual({
      kind: "plan", id: "trt-1", pinned: false, label: "Start statin or statin-like approach", date: "2099-06",
    });
  });

  it("prefers a decision over a planned treatment when both texts match (dual-source precedence)", () => {
    const c = client();
    c.factors!.treatments = [{ id: "t1", name: "Methylation stack", kind: "behavior", start: "2099-06" }]; // same text as the decision
    expect(resolvePatientRef(c, "Methylation stack")?.kind).toBe("decision");
  });

  it("returns null for an unresolved patient ref", () => {
    expect(resolvePatientRef(client(), "Nonexistent")).toBeNull();
  });

  it("resolves an ai ref to its intervention + purpose", () => {
    expect(resolveAiRef(client(), "Rosuvastatin")).toEqual({ intervention: "Rosuvastatin", purpose: "Cut ApoB" });
  });

  it("resolveTreatmentGroups maps refs, dropping unresolved ones", () => {
    const groups = resolveTreatmentGroups(client());
    expect(groups).not.toBeNull();
    expect(groups!.length).toBe(2);
    expect(groups![0].system).toBe("Cardiovascular Risk");
    expect(groups![0].ai.map((a) => a.intervention)).toEqual(["Rosuvastatin", "PCSK9 inhibitor"]);
    expect(groups![0].patient[0].kind).toBe("plan");
    expect(groups![1].patient[0].label).toBe("Methylation stack");
    expect(groups![1].ai).toEqual([]);
  });

  it("returns null when the Finding has no treatmentGroups (pre-W21 → heuristic fallback)", () => {
    const c = client();
    delete c.finding!.treatmentGroups;
    expect(resolveTreatmentGroups(c)).toBeNull();
  });
});

// M103 — buildHypothesisGroups relocated here from HypothesisTopicCard.svelte's module script
// (so search-index.ts could call it); this is its first unit coverage.
describe("buildHypothesisGroups", () => {
  it("filters patient items to kind 'decision' only, dropping 'plan' items, but keeps the topic if ai items remain", () => {
    // The fixture's "Lipid-lowering" topic resolves its one patient ref to a `kind: \"plan\"` item
    // (a committed Treatment Plan action, not a factors.decisions entry) — buildHypothesisGroups
    // (unlike resolveTreatmentGroups) should drop it from `patient`, but the topic survives since
    // its 2 ai items are untouched.
    const groups = buildHypothesisGroups(client());
    expect(groups).not.toBeNull();
    const lipid = groups!.find((g) => g.topic === "Lipid-lowering");
    expect(lipid).toBeTruthy();
    expect(lipid!.patient).toEqual([]);
    expect(lipid!.ai.map((a) => a.intervention)).toEqual(["Rosuvastatin", "PCSK9 inhibitor"]);
  });

  it("drops a topic entirely once its plan-kind patient items are filtered out and it has no ai items", () => {
    const c = client();
    c.finding!.treatmentGroups!.push({ system: "Renal", topic: "Hydration", patient: ["Start statin or statin-like approach"], ai: [] });
    const groups = buildHypothesisGroups(c);
    expect(groups!.find((g) => g.topic === "Hydration")).toBeUndefined();
  });

  it("defaults an empty system to UNCATEGORIZED", () => {
    const c = client();
    c.finding!.treatmentGroups![1].system = "";
    const groups = buildHypothesisGroups(c);
    expect(groups!.find((g) => g.topic === "Methyl donors")!.system).toBe(UNCATEGORIZED);
  });

  it("orders groups by systemOrder (finding.disease's severity order), not treatmentGroups' own order", () => {
    const c = client();
    // Reverse of the fixture's declared treatmentGroups order (Cardiovascular Risk, then
    // Methylation / Nutrient Status) — buildHypothesisGroups must re-sort by this, not preserve
    // input order.
    (c.finding as unknown as { disease: unknown }).disease = [
      { group: "Methylation / Nutrient Status", finding: "n/a" },
      { group: "Cardiovascular Risk", finding: "n/a" },
    ];
    const groups = buildHypothesisGroups(c);
    expect(groups!.map((g) => g.system)).toEqual(["Methylation / Nutrient Status", "Cardiovascular Risk"]);
  });

  it("returns null when the Finding has no treatmentGroups", () => {
    const c = client();
    delete c.finding!.treatmentGroups;
    expect(buildHypothesisGroups(c)).toBeNull();
  });
});

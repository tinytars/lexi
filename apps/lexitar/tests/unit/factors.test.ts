import { describe, it, expect } from "vitest";
import {
  factorsHashOf,
  findingInputsHashOf,
  addTreatment,
  addDecision,
  removeDecision,
  clearDecisions,
  setFactor,
  addDisease,
  reconcileTreatmentAttachments,
  addStudy,
  clearStudies,
  removeCriticalRatio,
} from "../../scripts/factors";
import type { Attachment, Client, TreatmentItem } from "../../src/lib/types";

function baseClient(): Client {
  return {
    displayName: "Test",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    factors: {},
  };
}

describe("factorsHashOf", () => {
  it("is deterministic for the same inputs", () => {
    const a = baseClient();
    const b = baseClient();
    expect(factorsHashOf(a)).toBe(factorsHashOf(b));
  });

  it("changes when height changes (height is a lifestyle factor that affects ranges)", () => {
    const a = baseClient();
    const before = factorsHashOf(a);
    setFactor(a, "height", "176cm");
    expect(factorsHashOf(a)).not.toBe(before);
  });

  it("does NOT change when decisions change (decisions are a speculative future-alternative, not a factor)", () => {
    const a = baseClient();
    const before = factorsHashOf(a);
    addDecision(a, { intervention: "TRT", purpose: "improved free T" });
    expect(factorsHashOf(a)).toBe(before);
  });

  it("does NOT change when treatments change (treatments feed the Finding, not personalized ranges)", () => {
    const a = baseClient();
    const before = factorsHashOf(a);
    addTreatment(a, { name: "Enclomiphene", dose: "12.5mg", kind: "drug", start: "2099-07" });
    expect(factorsHashOf(a)).toBe(before);
  });

  it("changes when BMI changes", () => {
    const a = baseClient();
    const before = factorsHashOf(a);
    setFactor(a, "bmi", "27.5");
    expect(factorsHashOf(a)).not.toBe(before);
  });

  it("is stable across field-insertion order", () => {
    const a = baseClient();
    setFactor(a, "height", "180cm");
    setFactor(a, "bmi", "24");
    const aHash = factorsHashOf(a);

    const b = baseClient();
    setFactor(b, "bmi", "24");
    setFactor(b, "height", "180cm");
    expect(factorsHashOf(b)).toBe(aHash);
  });
});

describe("findingInputsHashOf", () => {
  it("changes when watchlist changes", () => {
    const a = baseClient();
    const before = findingInputsHashOf(a);
    a.watchlist.push("ApoB");
    expect(findingInputsHashOf(a)).not.toBe(before);
  });

  it("changes when decisions change (decisions feed the Finding's decisions section and trigger regen)", () => {
    const a = baseClient();
    const before = findingInputsHashOf(a);
    addDecision(a, { intervention: "TRT", purpose: "improved free T" });
    expect(findingInputsHashOf(a)).not.toBe(before);
  });

  it("changes when height changes", () => {
    const a = baseClient();
    const before = findingInputsHashOf(a);
    setFactor(a, "height", "176cm");
    expect(findingInputsHashOf(a)).not.toBe(before);
  });

  it("changes when treatments change", () => {
    const a = baseClient();
    const before = findingInputsHashOf(a);
    addTreatment(a, { name: "Ezetimibe", dose: "10mg", kind: "drug", start: "2024-01" });
    expect(findingInputsHashOf(a)).not.toBe(before);
  });

  it("changes when a planned treatment is added (planned treatments feed the Finding)", () => {
    const a = baseClient();
    const before = findingInputsHashOf(a);
    addTreatment(a, { name: "Enclomiphene", dose: "12.5mg", kind: "drug", start: "2099-07" });
    expect(findingInputsHashOf(a)).not.toBe(before);
  });

  it("changes when results change", () => {
    const a = baseClient();
    const before = findingInputsHashOf(a);
    a.results.push({
      marker: "ApoB",
      group: "Lipids",
      source: "Blood",
      date: "2026-01-01",
      value: 76,
      unit: "mg/dL",
    });
    expect(findingInputsHashOf(a)).not.toBe(before);
  });
});

describe("addDecision / removeDecision / clearDecisions", () => {
  it("replaces an existing intervention rather than duplicating, and capFirsts the purpose", () => {
    const a = baseClient();
    addDecision(a, { intervention: "TRT", purpose: "first purpose" });
    addDecision(a, { intervention: "TRT", purpose: "second purpose" });
    expect(a.factors!.decisions).toHaveLength(1);
    // capFirst applies on both the intervention (already capitalized) and the purpose.
    expect(a.factors!.decisions![0].purpose).toBe("Second purpose");
  });

  it("removeDecision drops by intervention", () => {
    const a = baseClient();
    addDecision(a, { intervention: "TRT", purpose: "p1" });
    addDecision(a, { intervention: "Tesamorelin", purpose: "p2" });
    removeDecision(a, "TRT");
    expect(a.factors!.decisions).toHaveLength(1);
    expect(a.factors!.decisions![0].intervention).toBe("Tesamorelin");
  });

  it("clearDecisions drops all", () => {
    const a = baseClient();
    addDecision(a, { intervention: "TRT", purpose: "p" });
    clearDecisions(a);
    expect(a.factors!.decisions).toEqual([]);
  });
});

describe("addStudy / clearStudies", () => {
  it("appends a study entry and capFirsts focus and detail", () => {
    const a = baseClient();
    addStudy(a, { focus: "selection", detail: "found low ferritin" });
    expect(a.study!.entries).toHaveLength(1);
    expect(a.study!.entries![0]).toMatchObject({ focus: "Selection", detail: "Found low ferritin" });
  });

  it("appends rather than replacing on a repeat focus", () => {
    const a = baseClient();
    addStudy(a, { focus: "Selection", detail: "first" });
    addStudy(a, { focus: "Selection", detail: "second" });
    expect(a.study!.entries).toHaveLength(2);
  });

  it("clearStudies drops all entries", () => {
    const a = baseClient();
    addStudy(a, { focus: "Selection", detail: "d" });
    clearStudies(a);
    expect(a.study!.entries).toEqual([]);
  });

  it("clearStudies on a client with no study section is a no-op", () => {
    const a = baseClient();
    clearStudies(a);
    expect(a.study).toBeUndefined();
  });
});

describe("removeCriticalRatio", () => {
  function withRatios(...names: string[]) {
    const a = baseClient();
    a.finding = {
      criticalRatios: names.map((name) => ({ name, numerator: "A", denominator: "B", unit: "", meaning: "" })),
    } as Client["finding"];
    return a;
  }

  it("removes a ratio by case/whitespace-insensitive name match and returns true", () => {
    const a = withRatios("AST/ALT", "T/E2");
    expect(removeCriticalRatio(a, "  ast/alt ")).toBe(true);
    expect(a.finding!.criticalRatios!.map((r) => r.name)).toEqual(["T/E2"]);
  });

  it("returns false and leaves ratios untouched when the name doesn't match any", () => {
    const a = withRatios("AST/ALT");
    expect(removeCriticalRatio(a, "T/E2")).toBe(false);
    expect(a.finding!.criticalRatios).toHaveLength(1);
  });

  it("returns false when the client has no criticalRatios list at all", () => {
    const a = baseClient();
    expect(removeCriticalRatio(a, "AST/ALT")).toBe(false);
  });
});

describe("setFactor", () => {
  it("rejects unknown factor keys", () => {
    const a = baseClient();
    expect(() => setFactor(a, "unknownKey", "x")).toThrow();
  });

  it("accepts height as free-form string", () => {
    const a = baseClient();
    setFactor(a, "height", "5ft 5in");
    expect(a.factors!.height).toBe("5ft 5in");
  });

  it("rejects bad bmi", () => {
    const a = baseClient();
    expect(() => setFactor(a, "bmi", "-1")).toThrow();
    expect(() => setFactor(a, "bmi", "not-a-number")).toThrow();
  });
});

describe("addDisease", () => {
  it("appends a disease entry", () => {
    const a = baseClient();
    addDisease(a, { date: "2020", diagnostic: "NAFLD" });
    expect(a.factors!.diseases).toHaveLength(1);
  });

  // M67 Phase 2c — a month/year-only date must land already end-of-month, matching
  // normalizeClientDraft's own coercion, so a later web save can't silently change this date and
  // permanently desync the Finding's stamped nodeHashes from what the browser recomputes.
  it("coerces a month/year-only date to end-of-month, matching normalizeClientDraft", () => {
    const a = baseClient();
    addDisease(a, { date: "2024-01", diagnostic: "Hyperlipidemia" });
    expect(a.factors!.diseases![0].date).toBe("2024-01-31");
  });
});

describe("addTreatment date coercion (M67 Phase 2c)", () => {
  it("coerces start/end to end-of-month, matching normalizeClientDraft's own coercion", () => {
    const a = baseClient();
    addTreatment(a, { name: "Enclomiphene", dose: "12.5mg", kind: "drug", start: "2026-01", end: "2026-03" });
    expect(a.factors!.treatments![0].start).toBe("2026-01-31");
    expect(a.factors!.treatments![0].end).toBe("2026-03-31");
  });
});

// W78 — UnifiedTreatment.svelte's medicine-scope save can leave a row's rawCaptureAttachmentKeys
// pointing at a photo its own attachments no longer carries, which is exactly what report-merge.ts's
// per-row provenance check reads. Scoped to that invariant: a row gains an attachment only when it
// ITSELF claims the key, never as a side effect of a sibling merely having something extra.
describe("reconcileTreatmentAttachments", () => {
  const attach = (key: string): Attachment => ({ key, name: key, mediaType: "image/jpeg", bytes: 1, addedAt: "2026-08-24T00:00:00.000Z" });
  const row = (name: string, opts: { attachments?: string[]; rawCapture?: string[] }): TreatmentItem =>
    ({
      id: `id-${name}-${(opts.attachments ?? []).join("-")}-${(opts.rawCapture ?? []).join("-")}`,
      name,
      start: "2026-01-01",
      attachments: (opts.attachments ?? []).map(attach),
      ...(opts.rawCapture ? { extracted: { via: "photo", at: "2026-08-27T00:00:00.000Z" }, rawCaptureAttachmentKeys: opts.rawCapture } : {}),
    } as TreatmentItem);

  it("backfills a row's own claimed raw-capture key from a sibling that still has it", () => {
    const a = baseClient();
    a.factors!.treatments = [
      row("NAC", { attachments: ["a", "b"] }),
      row("NAC", { attachments: ["c", "d"], rawCapture: ["a", "b"] }),
    ];
    const added = reconcileTreatmentAttachments(a);
    expect(added).toBe(2);
    expect(a.factors!.treatments![1].attachments!.map((x) => x.key).sort()).toEqual(["a", "b", "c", "d"]);
  });

  // The exact shape of the real defect: a sibling holds an unrelated attachment pair that neither
  // row's provenance claims — a blanket union would wrongly hand it to every sibling.
  it("does NOT hand a row an attachment nothing claims, even if a sibling has it", () => {
    const a = baseClient();
    a.factors!.treatments = [
      row("NAC", { attachments: ["c", "d"] }),
      row("NAC", { attachments: ["e", "f"], rawCapture: ["a", "b"] }),
    ];
    reconcileTreatmentAttachments(a);
    expect(a.factors!.treatments![0].attachments!.map((x) => x.key)).toEqual(["c", "d"]);
    expect(a.factors!.treatments![1].attachments!.map((x) => x.key)).toEqual(["e", "f"]);
  });

  it("never removes an attachment a row already has — additive only", () => {
    const a = baseClient();
    a.factors!.treatments = [
      row("NAC", { attachments: ["a", "b"] }),
      row("NAC", { attachments: ["c"], rawCapture: ["a", "b"] }),
    ];
    reconcileTreatmentAttachments(a);
    expect(a.factors!.treatments![1].attachments!.map((x) => x.key).sort()).toEqual(["a", "b", "c"]);
  });

  it("groups by trimmed/lowercased name, matching treatment-bucket.ts's grouping convention", () => {
    const a = baseClient();
    a.factors!.treatments = [row("NAC", { attachments: ["a"] }), row(" nac ", { rawCapture: ["a"] })];
    reconcileTreatmentAttachments(a);
    expect(a.factors!.treatments![1].attachments!.map((x) => x.key)).toEqual(["a"]);
  });

  it("does nothing to a treatment with no siblings", () => {
    const a = baseClient();
    a.factors!.treatments = [row("Solo", { attachments: ["a"] })];
    expect(reconcileTreatmentAttachments(a)).toBe(0);
    expect(a.factors!.treatments![0].attachments!.map((x) => x.key)).toEqual(["a"]);
  });

  it("skips a row missing its claimed key entirely — no sibling has it to source from", () => {
    const a = baseClient();
    a.factors!.treatments = [
      row("NAC", { attachments: [] }),
      row("NAC", { attachments: [], rawCapture: ["missing-key"] }),
    ];
    expect(reconcileTreatmentAttachments(a)).toBe(0);
  });

  it("scopes to the given name, leaving other groups untouched", () => {
    const a = baseClient();
    a.factors!.treatments = [
      row("NAC", { attachments: ["a"] }),
      row("NAC", { attachments: [], rawCapture: ["a"] }),
      row("Other", { attachments: ["x"] }),
      row("Other", { attachments: [], rawCapture: ["x"] }),
    ];
    const added = reconcileTreatmentAttachments(a, "NAC");
    expect(added).toBe(1);
    expect(a.factors!.treatments![1].attachments!.map((x) => x.key)).toEqual(["a"]);
    expect(a.factors!.treatments![3].attachments).toEqual([]);
  });

  it("returns 0 and touches nothing when there are no treatments at all", () => {
    const a = baseClient();
    expect(reconcileTreatmentAttachments(a)).toBe(0);
  });
});

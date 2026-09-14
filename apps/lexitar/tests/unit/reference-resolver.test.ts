import { describe, it, expect } from "vitest";
import { resolveReference } from "../../src/lib/reference-resolver";
import {
  reportAnchor, diagnosisAnchor, markerAnchor, watchAnchor, ratioAnchor,
  treatmentAnchor, conditionAnchor, studyAnchor, futureAnchor, ideaAnchor,
} from "../../src/lib/anchor";
import type { Client, Vault } from "../../src/lib/types";
import type { Permalink } from "../../src/lib/permalink";

function client(): Client {
  return {
    displayName: "Pablo",
    dob: "1980-01-01",
    gender: "male",
    watchlist: ["Glucose"],
    results: [
      { marker: "LDL-C", group: "Lipids", source: "Blood", date: "2026-01-01", value: 100, unit: "mg/dL" },
      { marker: "Glucose", group: "Metabolic", source: "Blood", date: "2026-01-01", value: 90, unit: "mg/dL" },
      { marker: "Triglycerides", group: "Lipids", source: "Blood", date: "2026-01-01", value: 120, unit: "mg/dL" },
      { marker: "HDL", group: "Lipids", source: "Blood", date: "2026-01-01", value: 60, unit: "mg/dL" },
    ],
    sources: [
      { id: "src1", sha256: "abc", kind: "lab", file: "f.xlsx", originalName: "Quest Labs 2026-01", importedAt: "2026-01-02T00:00:00Z" },
    ],
    factors: {
      diseases: [{ date: "2026-01-01", diagnostic: "CAD", sourceId: "src1", summary: "CAC 220", icdCodes: ["I25.10"] }],
      treatments: [{ name: "Atorvastatin", dose: "10mg", kind: "drug", start: "2025-01" }],
      allergies: [{ id: "a1", allergen: "Penicillin", reaction: "Hives" }],
      familyHistory: [{ relation: "Father", condition: "Heart disease" }],
      decisions: [{ intervention: "Try keto", purpose: "lower Tg" }],
    },
    study: { entries: [{ focus: "Selection", detail: "genetic risk" }] },
    finding: {
      progression: { latest: "", recent: "", overall: "" },
      disease: [],
      treatment: [],
      doctorConversation: [],
      definitions: [],
      healthMarkers: { recommended: [] },
      generatedAt: "2026-01-01",
      inputsHash: "x",
      criticalRatios: [
        { name: "Triglyceride/HDL Ratio", numerator: "Triglycerides", denominator: "HDL", unit: "", meaning: "atherogenic balance", generalExplanation: "g", explanation: "e" },
      ],
      treatmentGroups: [{ system: "Cardiovascular", topic: "Statins", patient: [], ai: [] }],
      decisions: { patient: [], ai: [] },
    },
  } as unknown as Client;
}

function vault(c: Client): Vault {
  return { clients: { pablo: c } };
}

function pl(overrides: Partial<Permalink>): Permalink {
  return { client: "pablo", tab: "markers", ...overrides };
}

describe("resolveReference", () => {
  it("resolves a report anchor from client.sources", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ anchor: reportAnchor("src1") }));
    expect(r).toMatchObject({
      kind: "report",
      preview: { title: "Quest Labs 2026-01", subtitle: "2026-01-02", tag: "Lab" },
      context: {
        file: "Quest Labs 2026-01",
        kind: "lab",
        date: "2026-01-02",
        diagnoses: [{ diagnostic: "CAD", summary: "CAC 220", icdCodes: ["I25.10"] }],
      },
    });
  });

  it("resolves a diagnosis anchor nested under its report", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ anchor: diagnosisAnchor("src1", 0) }));
    expect(r).toMatchObject({
      kind: "diagnosis",
      preview: { title: "CAD", subtitle: "Quest Labs 2026-01", tag: "Diagnosis" },
      context: { diagnostic: "CAD", summary: "CAC 220", icdCodes: ["I25.10"], date: "2026-01-01" },
    });
  });

  it("resolves a marker anchor from client.results", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ anchor: markerAnchor("LDL-C") }));
    expect(r).toMatchObject({
      kind: "marker",
      preview: { title: "LDL-C", subtitle: "100 mg/dL (2026-01-01)", tag: "Marker" },
      context: { marker: "LDL-C", range: null },
    });
  });

  it("resolves a ratio anchor via buildMarkerRatios", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ anchor: ratioAnchor("Triglyceride/HDL Ratio") }));
    expect(r?.kind).toBe("ratio");
    expect(r?.preview.title).toBe("Triglyceride/HDL Ratio");
    expect(r?.preview.tag).toBe("Ratio");
    expect((r!.context as { name: string }).name).toBe("Triglyceride/HDL Ratio");
  });

  it("resolves a watchlist anchor from client.watchlist", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ anchor: watchAnchor("Glucose") }));
    expect(r).toMatchObject({
      kind: "watchlist",
      preview: { title: "Glucose", subtitle: "90 mg/dL (2026-01-01)", tag: "Watchlist" },
      context: { marker: "Glucose", range: null },
    });
  });

  it("resolves a treatment anchor via treatment-normalize", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ tab: "doctor", anchor: treatmentAnchor("Atorvastatin") }));
    expect(r).toMatchObject({
      kind: "treatment",
      preview: { title: "Atorvastatin", subtitle: "10mg", tag: "Treatment" },
      context: { name: "Atorvastatin", dose: "10mg", kind: "drug", start: "2025-01" },
    });
  });

  it("resolves a study anchor from client.study.entries", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ tab: "ai", anchor: studyAnchor("Selection") }));
    expect(r).toMatchObject({
      kind: "study",
      preview: { title: "Selection", subtitle: "genetic risk", tag: "Study" },
      context: { focus: "Selection", detail: "genetic risk" },
    });
  });

  it("resolves an idea anchor from factors.decisions", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ tab: "ai", anchor: ideaAnchor("Try keto", "patient", 0) }));
    expect(r).toMatchObject({
      kind: "idea",
      preview: { title: "Try keto", subtitle: "lower Tg", tag: "Idea" },
      context: { intervention: "Try keto", purpose: "lower Tg" },
    });
  });

  it("resolves a group anchor from finding.treatmentGroups", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ tab: "ai", anchor: futureAnchor("Statins") }));
    expect(r).toMatchObject({
      kind: "group",
      preview: { title: "Statins", subtitle: "Cardiovascular", tag: "Hypothesis" },
      context: { topic: "Statins", system: "Cardiovascular", patient: [], ai: [] },
    });
  });

  it("resolves a condition anchor across allergies and family history", () => {
    const v = vault(client());
    const allergy = resolveReference(v, "pablo", pl({ tab: "doctor", anchor: conditionAnchor("Penicillin") }));
    expect(allergy).toMatchObject({
      kind: "condition",
      preview: { title: "Penicillin", subtitle: "Hives", tag: "Allergy" },
      context: { allergen: "Penicillin", reaction: "Hives" },
    });

    const family = resolveReference(v, "pablo", pl({ tab: "doctor", anchor: conditionAnchor("Father") }));
    expect(family).toMatchObject({
      kind: "condition",
      preview: { title: "Father", subtitle: "Heart disease", tag: "Family History" },
      context: { relation: "Father", condition: "Heart disease" },
    });

    // Symptoms (the generic Conditions list) was fully deprecated and removed — an anchor that
    // used to resolve there now falls through to unresolved.
    const generic = resolveReference(v, "pablo", pl({ tab: "doctor", anchor: conditionAnchor("Hypertension") }));
    expect(generic!.kind).toBe("unresolved");
  });

  it("returns wrong-patient without touching another client's vault data", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ client: "liz", anchor: markerAnchor("LDL-C") }));
    expect(r).toEqual({
      kind: "wrong-patient",
      permalink: pl({ client: "liz", anchor: markerAnchor("LDL-C") }),
      preview: { title: "Different patient", tag: "Blocked" },
      context: null,
    });
  });

  it("returns unresolved for a garbage anchor with a registered prefix", () => {
    const r = resolveReference(vault(client()), "pablo", pl({ anchor: "chart-nonexistent-marker" }));
    expect(r).toMatchObject({ kind: "unresolved", preview: { title: "Link not found", tag: "Unresolved" }, context: null });
  });

  it("returns unresolved for the corr- and dec- stub prefixes (no real data source / no real emitter)", () => {
    const corr = resolveReference(vault(client()), "pablo", pl({ anchor: "corr-2026-01-01-some-event" }));
    expect(corr).toMatchObject({ kind: "unresolved", context: null });

    const dec = resolveReference(vault(client()), "pablo", pl({ anchor: "dec-some-intervention" }));
    expect(dec).toMatchObject({ kind: "unresolved", context: null });
  });

  it("resolves a whole-tab paste (no section, no anchor) to a section card with no context", () => {
    const r = resolveReference(vault(client()), "pablo", { client: "pablo", tab: "ai" });
    expect(r).toEqual({
      kind: "section",
      permalink: { client: "pablo", tab: "ai" },
      preview: { title: "Investigator", tag: "View" },
      context: null,
    });
  });

  it("resolves a section-level paste (section, no anchor) to a section card with no context", () => {
    const r = resolveReference(vault(client()), "pablo", { client: "pablo", tab: "doctor", section: "treatment" });
    expect(r).toEqual({
      kind: "section",
      permalink: { client: "pablo", tab: "doctor", section: "treatment" },
      preview: { title: "Treatment", tag: "View" },
      context: null,
    });
  });
});

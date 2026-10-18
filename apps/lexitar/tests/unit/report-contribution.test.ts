// W75 — this module exists so the browser fold and the CLI ingest share one implementation (its
// header says exactly that), and nothing asserted either half: 44% lines, 15% branches, no test.
// Two things need proving. That the mapping is right — a stated prior that disagrees with the vault
// must be reported, not quietly folded in as a second reading — and that the parity the module was
// extracted for still holds, which is a fact about the CALL SITES, not about this function.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { reportContribution, CONF_REVIEW } from "../../src/lib/report-contribution";
import type { Client, MarkerResult } from "../../src/lib/types";
import type { ProposedReport } from "@pablotech/akesi/report-extract";

const SURE = 0.9;
const UNSURE = CONF_REVIEW - 0.1;

const client = (results: Partial<MarkerResult>[] = []): Client =>
  ({ results: results as MarkerResult[] }) as Client;

const report = (over: Partial<ProposedReport> = {}): ProposedReport => ({
  studyType: "Echocardiogram",
  diseases: [],
  markers: [],
  ...over,
});

const marker = (over: Partial<ProposedReport["markers"][number]> = {}) => ({
  marker: "LVEF",
  value: 58,
  unit: "%",
  date: "2026-05-02",
  group: "Cardiac",
  confidence: SURE,
  ...over,
});

describe("the study date a whole import is filed under", () => {
  it("prefers the first finding's date, falls back to the first marker's, then to empty", () => {
    const withDisease = reportContribution(client(), "src-1", report({
      diseases: [{ date: "2026-01-02", diagnostic: "x", confidence: SURE }],
      markers: [marker({ date: "2026-05-02" })],
    }));
    expect(withDisease.studyDate).toBe("2026-01-02");

    expect(reportContribution(client(), "src-1", report({ markers: [marker()] })).studyDate).toBe("2026-05-02");
    expect(reportContribution(client(), "src-1", report()).studyDate).toBe("");
  });
});

describe("markers become vault rows under their catalog name", () => {
  it("canonicalises an alias and stamps the source id, so a re-import replaces rather than duplicates", () => {
    const c = reportContribution(client(), "src-7", report({ markers: [marker({ marker: "LVEF" })] }));
    expect(c.markerRows).toEqual([
      { marker: "Left ventricular ejection fraction (LVEF)", group: "Cardiac", source: "Imaging", date: "2026-05-02", value: 58, unit: "%", sourceId: "src-7" },
    ]);
    expect(c.markerLog[0].name).toBe("Left ventricular ejection fraction (LVEF)");
  });

  it("counts a name the catalog does not know, by canonical name and with repeats", () => {
    const c = reportContribution(client(), "src-1", report({
      markers: [marker({ marker: "Splenic vigor" }), marker({ marker: "Splenic vigor", date: "2026-06-01" }), marker({ marker: "LVEF" })],
    }));
    expect([...c.unknownMarkers]).toEqual([["Splenic vigor", 2]]);
  });
});

describe("header comorbidities are folded in as dated diagnoses", () => {
  it("dates them to the study and tags them with the ICD code", () => {
    const c = reportContribution(client(), "src-1", report({
      diseases: [{ date: "2026-01-02", diagnostic: "Aortic stenosis", summary: "moderate", confidence: SURE }],
      comorbidities: [{ code: "E11.9", label: "Type 2 diabetes", description: "Type 2 diabetes mellitus without complications", confidence: SURE }],
    }));
    expect(c.diseases).toEqual([
      { date: "2026-01-02", diagnostic: "Aortic stenosis", summary: "moderate" },
      { date: "2026-01-02", diagnostic: "Type 2 diabetes", icdCodes: ["E11.9"], summary: "Type 2 diabetes mellitus without complications" },
    ]);
  });

  it("drops a description that only repeats the label, rather than storing it twice", () => {
    const c = reportContribution(client(), "src-1", report({
      comorbidities: [{ code: "I10", label: "Hypertension", description: "  Hypertension  ", confidence: SURE }],
    }));
    expect(c.diseases[0].summary).toBeUndefined();
    expect(c.diseases[0].icdCodes).toEqual(["I10"]);
  });

  it("carries no ICD code when the extraction gave none", () => {
    const c = reportContribution(client(), "src-1", report({
      comorbidities: [{ code: "", label: "Hypertension", confidence: SURE }],
    }));
    expect(c.diseases[0].icdCodes).toEqual([]);
  });
});

describe("what gets flagged for a human to look at", () => {
  it("counts every low-confidence item across all four kinds", () => {
    const c = reportContribution(client(), "src-1", report({
      diseases: [{ date: "2026-01-02", diagnostic: "x", confidence: UNSURE }, { date: "2026-01-02", diagnostic: "y", confidence: SURE }],
      comorbidities: [{ code: "I10", label: "Hypertension", confidence: UNSURE }],
      markers: [marker({ confidence: UNSURE })],
      priorComparisons: [{ marker: "LVEF", priorValue: 55, priorDate: "2025-05-02", currentValue: 58, unit: "%", confidence: UNSURE }],
    }));
    expect(c.lowConfidence).toBe(4);
  });

  it("does not flag an item exactly at the review threshold", () => {
    const c = reportContribution(client(), "src-1", report({ markers: [marker({ confidence: CONF_REVIEW })] }));
    expect(c.lowConfidence).toBe(0);
  });
});

describe("a report's stated prior, checked against what the vault already holds", () => {
  const prior = { marker: "LVEF", priorValue: 55, priorDate: "2025-05-02", currentValue: 58, unit: "%", confidence: SURE };
  const vaultRow = (value: number, over: Partial<MarkerResult> = {}) => ({
    marker: "Left ventricular ejection fraction (LVEF)",
    date: "2025-05-02",
    value,
    unit: "%",
    ...over,
  });

  it("materialises it as a dated placeholder reading, marked as coming from a comparison", () => {
    const c = reportContribution(client(), "src-1", report({ priorComparisons: [prior] }));
    expect(c.markerRows).toEqual([
      { marker: "Left ventricular ejection fraction (LVEF)", group: "Imaging", source: "Imaging", date: "2025-05-02", value: 55, unit: "%", sourceId: "src-1", fromComparison: true },
    ]);
    expect(c.priorLog[0].tag).toBe("new prior point");
    expect(c.priorMismatches).toEqual([]);
  });

  it("takes the group from this report's own reading of the same marker when there is one", () => {
    const c = reportContribution(client(), "src-1", report({ markers: [marker({ group: "Cardiac" })], priorComparisons: [prior] }));
    expect(c.markerRows[1].group).toBe("Cardiac");
  });

  it("says so when it matches the vault within the tolerance", () => {
    const c = reportContribution(client([vaultRow(55.4)]), "src-1", report({ priorComparisons: [prior] }));
    expect(c.priorLog[0].tag).toBe("matches vault");
    expect(c.priorMismatches).toEqual([]);
  });

  it("REPORTS a disagreement instead of folding a second number in silently", () => {
    const c = reportContribution(client([vaultRow(61)]), "src-1", report({ priorComparisons: [prior] }));
    expect(c.priorLog[0].tag).toBe("MISMATCH — vault has 61 %");
    expect(c.priorMismatches).toEqual([
      { marker: "Left ventricular ejection fraction (LVEF)", priorValue: 55, priorDate: "2025-05-02", realValue: 61, unit: "%" },
    ]);
  });

  it("compares only against a REAL reading — another report's placeholder is not evidence", () => {
    const c = reportContribution(client([vaultRow(61, { fromComparison: true })]), "src-1", report({ priorComparisons: [prior] }));
    expect(c.priorLog[0].tag).toBe("new prior point");
    expect(c.priorMismatches).toEqual([]);
  });

  it("counts a prior whose marker the catalog does not know", () => {
    const c = reportContribution(client(), "src-1", report({
      priorComparisons: [{ ...prior, marker: "Splenic vigor" }],
    }));
    expect([...c.unknownMarkers]).toEqual([["Splenic vigor", 1]]);
  });
});

// The parity this module was extracted to guarantee is a property of its CALL SITE: a behavioural
// test of this function cannot see it drifting back to hand-rolling the mapping — a source
// assertion can, and that is the failure that reintroduces the CLI/browser divergence this
// replaced. The CLI ingest caller (scripts/commands/sources.ts) touches raw patient data and
// never entered this repo — it stays in the PHI carve-out; the browser fold is this repo's only
// caller.
describe("the implementation is not hand-rolled at its call site", () => {
  it.each([
    ["src/lib/import-flow.ts", "the browser fold"],
  ])("%s (%s) folds via reportContribution's own output", (path) => {
    const src = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    expect(src).toMatch(/reportContribution\(/);
    // Both must pass the contribution's fields straight through: a call site that computed its own
    // `markerRows` would not read `.markerRows` off the contribution.
    expect(src).toMatch(/applyReportContribution\([^)]*\.diseases,[^)]*\.markerRows\)/s);
  });
});

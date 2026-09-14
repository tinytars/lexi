import { describe, it, expect } from "vitest";
import { validate, type ProposedReport } from "../../scripts/claude-report";

function ok(): ProposedReport {
  return {
    studyType: "Coronary CTA",
    diseases: [{ date: "2019-04-02", diagnostic: "CAC: 210; CAD-RADS 3 in the Proximal RCA", summary: "Total CAC 210 (RCA 180, LAD 30); calcified plaque proximal RCA with 50-69% stenosis (CAD-RADS 3).", confidence: 0.95 }],
    comorbidities: [{ code: "I25.10", label: "Coronary artery disease", description: "Arteriosclerotic coronary artery disease", confidence: 0.9 }],
    priorComparisons: [{ marker: "Aortic valve mean gradient", priorValue: 10, priorDate: "2021-10-08", currentValue: 14, unit: "mmHg", confidence: 0.95 }],
    markers: [{ marker: "Coronary artery calcium (CAC) score", value: 210, unit: "", date: "2019-04-02", group: "Cardiac Imaging", confidence: 0.98 }],
  };
}

describe("claude-report validate", () => {
  it("accepts a well-formed payload", () => {
    expect(() => validate("f.pdf", ok())).not.toThrow();
  });

  it("accepts empty diseases, comorbidities, priorComparisons, and markers (a clean report)", () => {
    expect(() => validate("f.pdf", { studyType: "Renal Ultrasound", diseases: [], comorbidities: [], priorComparisons: [], markers: [] })).not.toThrow();
  });

  it("rejects a prior comparison without a priorDate", () => {
    const r = ok(); r.priorComparisons![0].priorDate = "";
    expect(() => validate("f.pdf", r)).toThrow(/priorComparisons\[0\] missing priorDate/);
  });

  it("rejects a non-finite prior comparison value", () => {
    const r = ok(); r.priorComparisons![0].priorValue = NaN;
    expect(() => validate("f.pdf", r)).toThrow(/priorComparisons\[0\] priorValue not finite/);
  });

  it("rejects a comorbidity without a label", () => {
    const r = ok(); r.comorbidities![0].label = "";
    expect(() => validate("f.pdf", r)).toThrow(/comorbidities\[0\] missing label/);
  });

  it("rejects a comorbidity confidence outside [0,1]", () => {
    const r = ok(); r.comorbidities![0].confidence = 2;
    expect(() => validate("f.pdf", r)).toThrow(/comorbidities\[0\] confidence/);
  });

  it("rejects a missing studyType", () => {
    const r = ok(); r.studyType = "";
    expect(() => validate("f.pdf", r)).toThrow(/studyType/);
  });

  it("rejects a disease without a diagnostic", () => {
    const r = ok(); r.diseases[0].diagnostic = "";
    expect(() => validate("f.pdf", r)).toThrow(/diagnostic/);
  });

  it("rejects a disease without a summary", () => {
    const r = ok(); r.diseases[0].summary = "";
    expect(() => validate("f.pdf", r)).toThrow(/summary/);
  });

  it("rejects a disease without a date", () => {
    const r = ok(); r.diseases[0].date = "";
    expect(() => validate("f.pdf", r)).toThrow(/date/);
  });

  it("rejects a non-finite marker value", () => {
    const r = ok(); r.markers[0].value = NaN;
    expect(() => validate("f.pdf", r)).toThrow(/value not finite/);
  });

  it("rejects confidence outside [0,1]", () => {
    const r = ok(); r.markers[0].confidence = 1.5;
    expect(() => validate("f.pdf", r)).toThrow(/confidence/);
  });
});

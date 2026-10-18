import { describe, it, expect } from "vitest";
import {
  slug, reportAnchor, diagnosisAnchor, markerAnchor, watchAnchor, ratioAnchor, treatmentAnchor,
  conditionAnchor, correlationAnchor, decisionAnchor, studyAnchor, futureAnchor,
  threadAnchor, messageAnchor, ideaAnchor, termAnchor, questionAnchor, anchorMatches, findByAnchor,
} from "../../src/lib/anchor";

describe("slug", () => {
  it("lowercases, collapses non-alphanumerics, trims dashes", () => {
    expect(slug("Triglyceride / HDL Ratio")).toBe("triglyceride-hdl-ratio");
    expect(slug("  LDL-C (calc.)  ")).toBe("ldl-c-calc");
    expect(slug("HbA1c")).toBe("hba1c");
  });
});

describe("entity anchors", () => {
  it("report uses the sha id verbatim", () => {
    expect(reportAnchor("abc123def456")).toBe("report-abc123def456");
  });
  it("diagnosis composes the report's anchor with a dx index", () => {
    expect(diagnosisAnchor("abc123def456", 0)).toBe("report-abc123def456-dx-0");
    expect(diagnosisAnchor("abc123def456", 2)).toBe("report-abc123def456-dx-2");
  });
  it("marker matches the existing chart element id shape", () => {
    expect(markerAnchor("Triglyceride/HDL Ratio")).toBe("chart-triglyceride-hdl-ratio");
  });
  it("watchlist marker prefixes watch- under the chart namespace", () => {
    expect(watchAnchor("Glucose")).toBe("chart-watch-glucose");
  });
  it("ratio prefixes ratio- under the chart namespace", () => {
    expect(ratioAnchor("Triglyceride/HDL Ratio")).toBe("chart-ratio-triglyceride-hdl-ratio");
  });
  it("treatment, condition, decision, study", () => {
    expect(treatmentAnchor("Atorvastatin")).toBe("rx-atorvastatin");
    expect(conditionAnchor("Coronary artery disease")).toBe("cond-coronary-artery-disease");
    expect(decisionAnchor("Start statin")).toBe("dec-start-statin");
    expect(studyAnchor("Selection")).toBe("study-selection");
    expect(futureAnchor("Rapamycin trial")).toBe("spec-rapamycin-trial");
  });
  it("correlation combines date and event", () => {
    expect(correlationAnchor("2025-03", "Began keto")).toBe("corr-2025-03-began-keto");
  });
  it("thread uses its id; message keys by thread + turn index", () => {
    expect(threadAnchor("t2")).toBe("t2");
    expect(messageAnchor("t2", 3)).toBe("t2-turn-3");
  });
  it("idea composes topic's futureAnchor with side + index", () => {
    expect(ideaAnchor("Rapamycin trial", "patient", 0)).toBe("spec-rapamycin-trial-patient-0");
    expect(ideaAnchor("Rapamycin trial", "ai", 2)).toBe("spec-rapamycin-trial-ai-2");
  });
});

describe("term", () => {
  it("slugs the term text", () => {
    expect(termAnchor("HbA1c")).toBe("term-hba1c");
    expect(termAnchor("Triglyceride / HDL Ratio")).toBe("term-triglyceride-hdl-ratio");
  });
});

describe("question", () => {
  it("composes the owning group with a question index", () => {
    expect(questionAnchor("Cardiovascular", 0)).toBe("question-cardiovascular-0");
    expect(questionAnchor("Cardiovascular", 2)).toBe("question-cardiovascular-2");
  });
});

// W64 — five sections reverse-match a pendingAnchor back to the group that owns it. Three used
// `=== || startsWith(anchor + "-")`; MarkersTab and UnifiedTreatment used strict equality alone, so
// an item-level deep link (whose id is the cell's plus a suffix) never matched and the link landed
// on whatever group happened to be active. One predicate now, asserted here and in use below.
describe("anchorMatches", () => {
  it("matches the cell's own anchor", () => {
    expect(anchorMatches(markerAnchor("ApoB"), markerAnchor("ApoB"))).toBe(true);
  });

  it("matches an item INSIDE the cell — the case strict equality missed", () => {
    const cell = treatmentAnchor("Ezetimibe");
    expect(anchorMatches(`${cell}-2`, cell)).toBe(true);
    expect(anchorMatches(diagnosisAnchor("src-1", 3), reportAnchor("src-1"))).toBe(true);
  });

  // The predicate alone is ambiguous, which is why call sites use findByAnchor instead: a sibling
  // marker's own anchor can be a prefix-child of another's.
  it("cannot tell a nested item from a sibling whose name extends this one", () => {
    expect(anchorMatches(markerAnchor("ApoB Ratio"), markerAnchor("ApoB"))).toBe(true);
    expect(anchorMatches(markerAnchor("ApoB"), markerAnchor("ApoB Ratio"))).toBe(false);
  });
});

describe("findByAnchor", () => {
  const markers = [{ name: "ApoB" }, { name: "ApoB Ratio" }];
  const anchorOf = (m: { name: string }) => markerAnchor(m.name);

  it("prefers an EXACT match over a prefix match found earlier in the list", () => {
    // "ApoB" comes first and apob-ratio startsWith("apob-"), so a single pass would hand it the
    // link meant for "ApoB Ratio". This is the case switching from === to prefix matching created.
    expect(findByAnchor(markers, markerAnchor("ApoB Ratio"), anchorOf)!.name).toBe("ApoB Ratio");
  });

  it("falls back to the owning cell for an item-level anchor", () => {
    expect(findByAnchor(markers, `${markerAnchor("ApoB")}-3`, anchorOf)!.name).toBe("ApoB");
  });

  it("returns undefined when nothing owns it", () => {
    expect(findByAnchor(markers, "cond-something-else", anchorOf)).toBeUndefined();
  });
});

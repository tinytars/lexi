// W75 — report-sections.ts was 28% lines with 0% branches: every presence predicate that decides
// what a patient actually sees was unexecuted. Both directions matter and they fail differently. A
// predicate that is wrongly false HIDES data the patient has (their study answers, their reports,
// their glossary) with no error anywhere; one that is wrongly true shows an empty sub-tab. The
// doctor-conversation slicing is the subtle one: three groups are one flat array cut by the counts
// of two OTHER arrays, so a drift in either makes the wrong questions appear under the wrong heading.

import { describe, it, expect } from "vitest";
import { isSectionPresent, presentSections, ALL_SECTIONS, AI_SECTIONS } from "../../src/lib/report-sections";
import type { Client } from "../../src/lib/types";

const client = (over: Record<string, unknown> = {}): Client => ({ results: [], ...over }) as unknown as Client;
const finding = (over: Record<string, unknown> = {}) =>
  ({ disease: [], doctorConversation: [], definitions: [], healthMarkers: { recommended: [] }, ...over });

const qs = (n: number) => Array.from({ length: n }, (_, i) => ({ group: `g${i}`, questions: ["q"] }));
const decisions = (patient: number, ai: number) => ({
  patient: Array.from({ length: patient }, () => ({ intervention: "x" })),
  ai: Array.from({ length: ai }, () => ({ intervention: "y" })),
});

/** key → [a client that must show it, a client that must hide it]. `null` = never hidden. */
const CASES: Record<string, [Client, Client | null]> = {
  analysis: [client({ finding: finding() }), client()],
  study: [client({ finding: finding({ studyResults: [{ study: "s" }] }) }), client({ finding: finding() })],
  futureTreatment: [client({ finding: finding({ decisions: decisions(0, 1) }) }), client({ finding: finding() })],
  exploration: [client({ finding: finding({ dataRequisition: [{ type: "Labs", items: ["x"] }] }) }), client({ finding: finding() })],
  healthReports: [client({ sources: [{ id: "s1" }] }), client({ sources: [] })],
  healthMarkers: [
    client({ finding: finding({ healthMarkers: { recommended: [{ group: "g", markers: [{ name: "n", rationale: "r" }] }] } }) }),
    client({ finding: finding({ healthMarkers: { recommended: [{ group: "g", markers: [] }] } }) }),
  ],
  definitions: [client({ finding: finding({ definitions: [{ term: "t", definition: "d", group: "g" }] }) }), client({ finding: finding() })],
  docInference: [
    client({ finding: finding({ disease: [{ name: "d" }], doctorConversation: qs(1) }) }),
    client({ finding: finding({ doctorConversation: qs(1), decisions: decisions(1, 0) }) }),
  ],
  treatment: [client(), null],
  markers: [client(), null],
  personalization: [client(), null],
  notes: [client(), null],
  allergies: [client(), null],
  familyHistory: [client(), null],
};

describe("what the patient is shown, and what is hidden as empty", () => {
  it.each(Object.entries(CASES))("%s", (key, [shown, hidden]) => {
    expect(isSectionPresent(shown, key)).toBe(true);
    if (hidden) expect(isSectionPresent(hidden, key)).toBe(false);
  });

  // Without this, a section added to a tab array with no matching entry above keeps its predicate
  // untested — which is the state this whole file was in.
  it("covers every section that can appear in a tab", () => {
    expect(ALL_SECTIONS.map((s) => s.key).filter((k) => !(k in CASES))).toEqual([]);
  });

  it("defaults an unknown key to present, so a new section is never invisible by omission", () => {
    expect(isSectionPresent(client(), "a-section-nobody-wrote-a-predicate-for")).toBe(true);
  });

  it("a client with no finding still keeps the always-available sections", () => {
    const keys = presentSections(client(), ALL_SECTIONS).map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["treatment", "markers", "personalization", "notes"]));
    expect(keys).not.toContain("analysis");
  });
});

describe("the doctor-conversation groups are one array sliced by two other counts", () => {
  const dcClient = (nDisease: number, nPatient: number, nQuestions: number) =>
    client({
      finding: finding({
        disease: Array.from({ length: nDisease }, (_, i) => ({ name: `d${i}` })),
        decisions: decisions(nPatient, 0),
        doctorConversation: qs(nQuestions),
      }),
    });

  it("splits inference / patient / ai at the disease and patient-hypothesis counts", () => {
    const c = dcClient(2, 1, 5); // 2 inference, 1 patient, 2 left over for the AI
    expect(isSectionPresent(c, "docInference")).toBe(true);
    expect(isSectionPresent(c, "docPatient")).toBe(true);
    expect(isSectionPresent(c, "docAi")).toBe(true);
  });

  it("hides the groups the array does not reach", () => {
    const c = dcClient(2, 3, 2); // only the two inference questions exist
    expect(isSectionPresent(c, "docInference")).toBe(true);
    expect(isSectionPresent(c, "docPatient")).toBe(false);
    expect(isSectionPresent(c, "docAi")).toBe(false);
  });

  it("attributes every question to the AI when there are no diseases and no patient hypotheses", () => {
    const c = dcClient(0, 0, 3);
    expect(isSectionPresent(c, "docInference")).toBe(false);
    expect(isSectionPresent(c, "docPatient")).toBe(false);
    expect(isSectionPresent(c, "docAi")).toBe(true);
  });
});

describe("the PDF-only predicates, which no sub-tab exercises", () => {
  it.each([
    ["aiHypothesis", client({ finding: finding({ decisions: decisions(0, 1) }) }), client({ finding: finding({ decisions: decisions(0, 0) }) })],
    ["hypothesisEvaluation", client({ finding: finding({ decisions: decisions(1, 0) }) }), client({ finding: finding({ decisions: decisions(0, 0) }) })],
    ["clinicalSynthesis", client({ finding: finding({ clinicalSynthesis: { adverse: "a", favorable: "f" } }) }), client({ finding: finding() })],
    ["patternAntipattern", client({ finding: finding({ patternAntipattern: { pattern: "p", antipattern: "a" } }) }), client({ finding: finding() })],
    ["finalThoughts", client({ finding: finding({ finalThoughts: "t" }) }), client({ finding: finding() })],
    ["aiConclusion", client({ finding: finding() }), client()],
    ["healthProgression", client({ finding: finding() }), client()],
    ["healthFinding", client({ finding: finding() }), client()],
    ["treatmentAssessment", client({ finding: finding() }), client()],
  ])("%s", (key, shown, hidden) => {
    expect(isSectionPresent(shown, key)).toBe(true);
    expect(isSectionPresent(hidden, key)).toBe(false);
  });

  it("longitudinalChange needs more than one reading — a single point is not a trend", () => {
    const reading = { marker: "m", date: "2026-01-01", value: 1, unit: "u" };
    expect(isSectionPresent(client({ results: [reading] }), "longitudinalChange")).toBe(false);
    expect(isSectionPresent(client({ results: [reading, reading] }), "longitudinalChange")).toBe(true);
  });
});

describe("presentSections", () => {
  it("keeps the order it was given and drops only the absent ones", () => {
    const c = client({ finding: finding({ dataRequisition: [{ type: "Labs", items: ["x"] }] }) });
    expect(presentSections(c, AI_SECTIONS).map((s) => s.key)).toEqual(["analysis", "exploration"]);
  });

  it("returns nothing when nothing in the list is present", () => {
    expect(presentSections(client(), [AI_SECTIONS[1]])).toEqual([]);
  });
});

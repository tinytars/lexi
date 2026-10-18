// A response carrying exactly the core's own sections and none of the leaf-owned ones, which the
// real validator accepts — shared so tests drive validation through data rather than mocking it.
function rep(s: string, n: number) {
  return Array.from({ length: n }, () => s).join(" ");
}
const PROSE = rep("Lorem ipsum dolor sit amet.", 12);
export const decision = (intervention: string) => ({
  intervention,
  purpose: "a purpose long enough to pass",
  pros: ["pro one with enough chars", "pro two with enough chars", "pro three with enough chars"],
  cons: ["con one with enough chars", "con two with enough chars", "con three with enough chars"],
  alternatives: ["alt one with enough chars", "alt two with enough chars"],
  recommendation: rep("Recommendation sentence here.", 8),
});

export function coreOnlyResponse() {
  return {
    progression: { latest: PROSE, recent: PROSE, overall: PROSE },
    patternAntipattern: { pattern: PROSE, antipattern: PROSE },
    clinicalSynthesis: { adverse: PROSE, favorable: PROSE, conditioning: PROSE },
    criticalRatios: [
      { name: "Triglycerides : HDL", numerator: "Triglycerides", denominator: "HDL", unit: "", meaning: "Insulin-resistance proxy.", generalLow: 0, generalHigh: 2, generalExplanation: "guideline band", personalizedLow: 0, personalizedHigh: 1.5, explanation: "tighter for CV risk" },
      { name: "Total cholesterol : HDL", numerator: "Total cholesterol", denominator: "HDL", unit: "", meaning: "Atherogenic balance.", generalHigh: 5, generalExplanation: "guideline band", personalizedHigh: 3.5, explanation: "tighter for secondary prevention" },
    ],
    // validate requires >= 4 body systems.
    disease: [
      { group: "Cardiovascular Risk", finding: rep("CV finding sentence.", 8) },
      { group: "Metabolic Health", finding: rep("Metabolic finding sentence.", 8) },
      { group: "Hormonal / Endocrine", finding: rep("Hormonal finding sentence.", 8) },
      { group: "Hepatic", finding: rep("Hepatic finding sentence.", 8) },
    ],
    decisions: { patient: [], ai: [decision("Statin or PCSK9 inhibitor")] },
    doctorConversation: [
      { group: "Cardiovascular Risk", questions: ["Ask about ApoB target."] },
      { group: "Metabolic Health", questions: ["Ask about HbA1c trend."] },
      { group: "Hormonal / Endocrine", questions: ["Ask about Free T basis."] },
      { group: "Hepatic", questions: ["Ask about FibroScan timing."] },
      { group: "Statin or PCSK9 inhibitor", questions: ["Ask which is right for me."] },
    ],
    definitions: [
      { term: "ApoB", definition: "Apolipoprotein B — a cholesterol carrier.", group: "Cardiovascular Risk" },
      { term: "HbA1c", definition: "Glycated hemoglobin — 3-month average blood sugar.", group: "Metabolic Health" },
      { term: "Free T", definition: "Free testosterone — the unbound, active fraction.", group: "Hormonal / Endocrine" },
    ],
    healthMarkers: { recommended: [{ group: "Cardiovascular Risk", markers: [{ name: "ApoB", rationale: "rationale at least ten chars" }] }] },
    dataRequisition: [{ type: "Blood", group: "Cardiovascular Risk", items: ["Lp(a) — distinguish inherited risk"] }],
    planAssessment: PROSE,
    finalThoughts: PROSE,
    // Lifted verbatim from finding-validate.test.ts's known-good fixture: basis shapes are fussy
    // (Shape A vs Shape B per key) and re-deriving them here would test my copy, not the validator.
    basis: {
      // user-entered sections use Shape A: literal "Based on user input."
      patientAssessment: "Based on user input.",
      patientProfile: "Based on user input.",
      statedObjective: "Based on user input.",
      pursuedStudy: "Based on user input.",
      pursuedNotes: "Based on user input.",
      diagnosedDisease: "Based on user input.",
      treatmentHistory: "Based on user input.",
      correlationHistory: "Based on user input.",
      patientHypothesis: "Based on user input.",
      // LLM-inferred sections use Shape B: name the input sections (Title Case)
      markerLevels: "Based on your lab data (user input) and AI-inferred personalized levels from Patient Assessment (user input).",
      aiFindings: "Based on Patient Assessment (user input) and Marker Levels (raw user data and AI).",
      healthProgression: "Based on your lab data and Marker Levels (raw user data and AI).",
      studyResults: "Based on Patient Assessment (user input) and Marker Levels (raw user data and AI).",
      noteResults: "Based on Patient Assessment (user input) and Marker Levels (raw user data and AI).",
      possibleFindings: "Based on Patient Assessment (user input) and Marker Levels (raw user data and AI).",
      treatmentAssessment: "Based on Patient Assessment (user input) and Marker Levels (raw user data and AI).",
      dataRequisition: "Based on Patient Assessment (user input) and Marker Levels (raw user data and AI).",
      aiHypothesis: "Based on Patient Assessment (user input), Marker Levels (raw user data and AI), and AI Findings (AI).",
      hypothesisEvaluation: "Based on Patient Assessment (user input), Marker Levels (raw user data and AI), Patient Hypothesis (user input), AI Findings (AI), and AI Hypothesis (AI).",
      doctorConversation: "Based on Patient Assessment (user input), Marker Levels (raw user data and AI), Patient Hypothesis (user input), AI Findings (AI), AI Hypothesis (AI), and Hypothesis Evaluation (AI).",
      healthMarkers: "Based on your Watchlist (user input) and the Finding's Recommended set (AI).",
      patientPlan: "Based on user input.",
      patternAntipattern: "Based on Patient Assessment (user input), Marker Levels (raw user data and AI), and AI Findings (AI).",
      clinicalSynthesis: "Based on Diagnosed Disease (user input), Health Finding (AI), Marker Levels (raw user data and AI), and Treatment History (user input).",
      criticalRatios: "Based on your lab data, Diagnosed Disease (user input), and Health Finding (AI).",
      aiOnPlan: "Based on Patient Plan (user input), Patient Assessment (user input), and AI Findings (AI).",
      finalThoughts: "Based on every section of this report (user input and AI).",
      abbreviations: "Based on every other section (user input and AI) in this report.",
      treatmentGroups: "Based on Patient Hypothesis (user input), Patient Plan (user input), and AI Hypothesis (AI).",
    },
  };
}

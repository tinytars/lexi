import type { ClientFinding, FindingDecisionEntry } from "../types";
import { HYPOTHESIS_EVALUATION_TOOL, HYPOTHESIS_EVALUATION_SYSTEM_PROMPT } from "../leaf-regen-prompts";
import { assertDecisionBody, assertLabelSetMatches, labelSubject, mergeLabeledItems } from "../leaf-regen-rows";
import type { LeafRegenSpec } from "./spec";

interface HypothesisEvaluationEntry extends FindingDecisionEntry {
  questions: string[];
}

// Rebuilds doctorConversation's middle band (disease groups, then patient decisions, then AI considerations).
// Groups for interventions not answered this run keep their prior questions.
function withPatientDecisionQuestions(
  finding: ClientFinding,
  mergedPatient: FindingDecisionEntry[],
  answered: HypothesisEvaluationEntry[],
): { group: string; questions: string[] }[] {
  const dc = finding.doctorConversation ?? [];
  const diseaseCount = (finding.disease ?? []).length;
  const head = dc.slice(0, diseaseCount);
  const tail = dc.slice(diseaseCount);
  const patientNames = new Set(mergedPatient.map((d) => d.intervention));
  // The old middle band is whatever trailing groups name a patient decision; the AI band follows it.
  const aiBand = tail.filter((g) => !patientNames.has(g.group));
  const priorByName = new Map(tail.map((g) => [g.group, g.questions]));
  const freshByName = new Map(answered.map((e) => [e.intervention, e.questions]));
  const middle = mergedPatient
    .map((d) => ({ group: d.intervention, questions: freshByName.get(d.intervention) ?? priorByName.get(d.intervention) ?? [] }))
    .filter((g) => g.questions.length > 0);
  return [...head, ...middle, ...aiBand];
}

// Regenerates only finding.decisions.patient, leaving decisions.ai (the aiHypothesis core node) untouched.
export const hypothesisEvaluation: LeafRegenSpec = {
  node: "hypothesisEvaluation",
  toolSchema: HYPOTHESIS_EVALUATION_TOOL,
  systemPromptExtra: HYPOTHESIS_EVALUATION_SYSTEM_PROMPT,
  scopedArrayKey: "patient",
  isEmpty: (context) => (context.patientHypothesis as unknown[]).length === 0,
  validate: (raw): { patient: HypothesisEvaluationEntry[] } => {
    const patient = (raw as { patient?: unknown })?.patient;
    if (!Array.isArray(patient)) throw new Error("patient missing or not an array");
    for (const entry of patient) {
      const e = entry as Partial<HypothesisEvaluationEntry>;
      if (
        typeof e?.intervention !== "string" ||
        typeof e?.purpose !== "string" ||
        !Array.isArray(e?.pros) ||
        !Array.isArray(e?.cons) ||
        !Array.isArray(e?.alternatives) ||
        typeof e?.recommendation !== "string" ||
        !Array.isArray(e?.questions) ||
        e.questions.length === 0
      ) {
        throw new Error("patient entry does not match FindingDecisionEntry shape (with questions)");
      }
      // This leaf owns decisions.patient, so the core path's body check never sees these entries.
      assertDecisionBody(`hypothesisEvaluation "${e.intervention}"`, e as FindingDecisionEntry);
    }
    return { patient: patient as HypothesisEvaluationEntry[] };
  },
  checkAgainstInput: (context, result, targetLabels) => {
    const { patient } = result as { patient: HypothesisEvaluationEntry[] };
    assertLabelSetMatches(
      "hypothesisEvaluation",
      "ideas",
      (context.patientHypothesis as { intervention: string }[]).map((d) => d.intervention),
      patient.map((e) => e.intervention),
      targetLabels,
    );
  },
  mergeInto: (client, result) => {
    const { patient } = result as { patient: HypothesisEvaluationEntry[] };
    const merged = mergeLabeledItems(
      client.finding?.decisions?.patient ?? [],
      patient.map(({ questions: _q, ...d }) => d),
      (d) => d.intervention,
      undefined,
      (d) => labelSubject(d.intervention),
    );
    return {
      ...client,
      finding: {
        ...client.finding!,
        decisions: { ai: client.finding?.decisions?.ai ?? [], patient: merged },
        // The core emits decisions.patient empty, so the leaf that owns it must also refill doctorConversation's middle band.
        doctorConversation: withPatientDecisionQuestions(client.finding!, merged, patient),
      },
    };
  },
};

import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";

// One place that knows what a VALID /api/leaf-regen response looks like.
//
// W68 — five spec files hand-rolled these payloads, and each had to be patched every time the contract
// tightened: W66 added `questions` to hypothesisEvaluation, W67 added the echoed row id to the four
// id-keyed nodes, W67 added 2-8 bullet counts to the decision body. Three rounds of the same edit
// across the same files, each found only when a spec failed for a reason that had nothing to do with
// what it was testing.
//
// The payload is DERIVED from the request's own inputs rather than hardcoded, so it satisfies the id
// and coverage checks by construction: answer every row you were given, echoing the id you were given.
// `leaf-payloads.test.ts` runs every node's output through the real `validateLeafResult`, so the next
// tightening breaks one unit test with a clear message instead of five e2e specs with obscure ones.

type Inputs = Record<string, unknown>;
type Rows = { id: string }[];

const rowsOf = (inputs: Inputs, key: string): Rows => (inputs[key] as Rows) ?? [];

/** A body-system tag the Finding actually has — every group-bearing node's merge checks this. */
function groupOf(inputs: Inputs): string {
  const findings = (inputs.aiFindings as { group?: string }[]) ?? [];
  return findings[0]?.group ?? "Cardiovascular Risk";
}

/** The decision body finding-assemble.ts demands: 2-8 non-empty bullets per field, non-empty prose. */
const decisionBody = () => ({
  pros: ["stub pro one", "stub pro two"],
  cons: ["stub con one", "stub con two"],
  alternatives: ["stub alternative one", "stub alternative two"],
  recommendation: "Stub recommendation, for a test.",
});

/**
 * A valid `result` for one node, derived from the inputs that node was sent.
 *
 * `text` seeds the visible prose so a spec can assert on something it chose. `perRow` lets a spec vary
 * the answer per row — the noteResults pairing spec uses it to derive each answer from its own row, so
 * a mispaired answer names the row that actually got it.
 */
export function validLeafPayload(
  node: string,
  inputs: Inputs,
  opts: { text?: string; perRow?: (row: Record<string, unknown>, i: number) => string } = {},
): unknown {
  const group = groupOf(inputs);
  const say = (row: Record<string, unknown>, i: number) => opts.perRow?.(row, i) ?? opts.text ?? `stub ${node} result`;
  const idRows = (key: string, idField: string) =>
    rowsOf(inputs, key).map((r, i) => ({ [idField]: r.id, result: say(r as Record<string, unknown>, i), group }));

  switch (node) {
    case "noteResults":
      return { items: idRows("pursuedNotes", "noteId") };
    case "allergyResults":
      return { items: idRows("patientAllergies", "allergyId") };
    case "familyResults":
      return { items: idRows("patientFamilyHistory", "familyId") };
    case "diseaseResults":
      return { items: idRows("diagnosedDisease", "diseaseId") };

    case "studyResults": {
      const entries = ((inputs.pursuedStudy as { entries?: { focus: string }[] })?.entries ?? []);
      return { items: entries.map((e, i) => ({ study: e.focus, result: say(e as never, i), group })) };
    }
    case "treatmentAssessment": {
      // W71 — treatmentId echoes the id it was given, exactly as the real model is now required to.
      // The stub must obey the same contract or e2e passes on payloads the validator would reject.
      const items = (inputs.treatmentHistory as { id: string; name: string }[]) ?? [];
      return { items: items.map((t, i) => ({ treatmentId: t.id, item: t.name, assessment: say(t as never, i), group })) };
    }
    case "hypothesisEvaluation": {
      const ideas = (inputs.patientHypothesis as { intervention: string; purpose?: string }[]) ?? [];
      return {
        patient: ideas.map((d, i) => ({
          intervention: d.intervention,
          purpose: d.purpose || "a stated purpose",
          ...decisionBody(),
          recommendation: say(d as never, i),
          questions: ["stub question"],
        })),
      };
    }
    case "aiOnPlan": {
      const plan = (inputs.patientPlan as { name: string }[]) ?? [];
      return { rows: plan.map((t, i) => ({ action: t.name, assessment: say(t as never, i) })) };
    }
    case "treatmentGroups": {
      // The one node addressed by id-refs (S#/P#/A#/AI#) rather than by content — see finding-regroup.
      // Every ref must be covered exactly once, so all of them go in one group.
      const inp = inputs as unknown as {
        systems: { id: string }[];
        patientHypotheses: { id: string }[];
        planActions: { id: string }[];
        aiInterventions: { id: string }[];
      };
      return {
        groups: [
          {
            system: inp.systems?.[0]?.id ?? "S1",
            topic: opts.text ?? "Stub group",
            patient: [...(inp.patientHypotheses ?? []), ...(inp.planActions ?? [])].map((r) => r.id),
            ai: (inp.aiInterventions ?? []).map((r) => r.id),
          },
        ],
      };
    }
    default:
      throw new Error(`_leaf-payloads: no builder for "${node}" (specs: ${Object.keys(LEAF_REGEN_SPECS).join(", ")})`);
  }
}

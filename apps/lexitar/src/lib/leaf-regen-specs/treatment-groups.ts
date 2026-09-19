import {
  buildRegroupInputs,
  REGROUP_SYSTEM_PROMPT,
  TREATMENT_GROUPS_TOOL,
  validateRegroup,
  resolveRegroup,
  type RegroupInputs,
  type RegroupResponse,
} from "@pablotech/akesi/finding-regroup";
import type { LeafRegenSpec } from "./spec";

// Id-ref tagged (S#/P#/A#/AI#) context from buildRegroupInputs. validate is shape-only; the id-coverage check needs
// those inputs, so it runs in mergeInto where the client can rebuild them.
export const treatmentGroups: LeafRegenSpec = {
  node: "treatmentGroups",
  ownedSections: ["treatmentGroups"],
  toolSchema: TREATMENT_GROUPS_TOOL,
  systemPromptExtra: REGROUP_SYSTEM_PROMPT,
  buildContext: (client) => buildRegroupInputs(client) as unknown as Record<string, unknown>,
  isEmpty: (context) => {
    const inputs = context as unknown as RegroupInputs;
    return inputs.aiInterventions.length === 0 && inputs.patientHypotheses.length === 0 && inputs.planActions.length === 0;
  },
  validate: (raw): RegroupResponse => {
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as RegroupResponse).groups)) {
      throw new Error("groups missing or not an array");
    }
    return raw as RegroupResponse;
  },
  mergeInto: (client, result) => {
    const inputs = buildRegroupInputs(client);
    const resp = result as RegroupResponse;
    validateRegroup(resp, inputs);
    const groups = resolveRegroup(resp, inputs);
    return { ...client, finding: { ...client.finding!, treatmentGroups: groups } };
  },
};

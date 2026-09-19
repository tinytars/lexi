// Isomorphic (no node:/SDK imports): both functions/api/leaf-regen.ts and the browser import this module.

import type { Client } from "./types";
import { dagNode } from "./finding-dag";
import { BRAIN_VERSIONS } from "./brain-versions";
import { buildLeafContext } from "./leaf-regen-context";
import type { LeafRegenSpec } from "./leaf-regen-specs/spec";
import { aiOnPlan } from "./leaf-regen-specs/ai-on-plan";
import { hypothesisEvaluation } from "./leaf-regen-specs/hypothesis-evaluation";
import { treatmentGroups } from "./leaf-regen-specs/treatment-groups";
import { treatmentAssessment } from "./leaf-regen-specs/treatment-assessment";
import { studyResults } from "./leaf-regen-specs/study-results";
import { noteResults, allergyResults, familyResults, diseaseResults } from "./leaf-regen-specs/id-rows";

export const LEAF_REGEN_SPECS: Record<string, LeafRegenSpec> = {
  aiOnPlan,
  hypothesisEvaluation,
  treatmentGroups,
  treatmentAssessment,
  studyResults,
  noteResults,
  allergyResults,
  familyResults,
  diseaseResults,
};

function specFor(node: string): LeafRegenSpec {
  const spec = LEAF_REGEN_SPECS[node];
  if (!spec) throw new Error(`no LEAF_REGEN_SPECS entry for node "${node}"`);
  return spec;
}

// The ONE way to build a node's context: a node with its own buildContext must not get the generic one.
export function leafContextFor(node: string, client: Client, targetLabels?: string[]): Record<string, unknown> {
  const spec = specFor(node);
  return spec.buildContext ? spec.buildContext(client, targetLabels) : buildLeafContext(node, client);
}

// The single gate before any merge (shape, then against the input), shared by the in-process and browser paths.
export function validateLeafResult(
  node: string,
  raw: unknown,
  context: Record<string, unknown>,
  targetLabels?: string[],
): unknown {
  const spec = specFor(node);
  const validated = spec.validate(raw);
  spec.checkAgainstInput?.(context, validated, targetLabels);
  return validated;
}

// The single place a leaf result joins the Finding, so every caller gets the same merge plus basis/version stamps.
export function mergeLeafResult(
  client: Client,
  node: string,
  validated: unknown,
  targetIds?: string[],
): Client {
  const merged = specFor(node).mergeInto(client, validated, targetIds);
  if (!merged.finding) return merged;
  const basis = dagNode(node)?.basis;
  const version = BRAIN_VERSIONS[node];
  const finding = { ...merged.finding };
  if (basis) finding.basis = { ...finding.basis, [node]: basis } as typeof finding.basis;
  if (version) finding.promptVersions = { ...finding.promptVersions, [node]: version };
  return { ...merged, finding };
}

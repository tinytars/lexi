import type { Client } from "./types";
import { dagNode } from "./finding-dag";
import { treatmentsOf } from "@pablotech/akesi/treatment-normalize";
import { bucketOf, todayISODate } from "@pablotech/akesi/treatment-bucket";
import { describeProfile, markerLevelBlocks, populatedNoteEntries } from "@pablotech/akesi/finding-generate";
import { dailyTotalsByName } from "./treatment-conclusion";

// One accessor per DAG input key a leaf node reads, reusing the monolith's exact source for that context.
const contextAccessors: Record<string, (client: Client) => unknown> = {
  aiFindings: (client) => client.finding?.disease ?? [],
  markerLevels: (client) => markerLevelBlocks(client),
  patientHypothesis: (client) => client.factors?.decisions ?? [],
  patientPlan: (client) => treatmentsOf(client).filter((t) => bucketOf(t, todayISODate()) === "planned"),
  aiHypothesis: (client) => client.finding?.decisions?.ai ?? [],
  // Rows keep their raw shape; ongoing rows gain the same summed `dailyTotal` chat-context.ts hands the chat.
  treatmentHistory: (client) => {
    const today = todayISODate();
    const items = treatmentsOf(client);
    const dailyTotals = dailyTotalsByName(items, today);
    return items.map((t) => {
      const total = dailyTotals.get(t.name.trim().toLowerCase());
      return total ? { ...t, dailyTotal: total } : t;
    });
  },
  pursuedStudy: (client) => client.study ?? {},
  pursuedNotes: (client) => populatedNoteEntries(client),
  hypothesisEvaluation: (client) => client.finding?.decisions?.patient ?? [],
  patientAssessment: (client) => describeProfile(client),
  patientAllergies: (client) => client.factors?.allergies ?? [],
  patientFamilyHistory: (client) => client.factors?.familyHistory ?? [],
  diagnosedDisease: (client) => client.factors?.diseases ?? [],
};

// A key with no accessor is skipped (logged, not thrown): a node may declare an input this engine doesn't model yet.
export function buildLeafContext(node: string, client: Client): Record<string, unknown> {
  // `today` is not a DAG input (so it churns no staleness hash), but CURRENT_DOSE_RULE and DATE AWARENESS key off it.
  const context: Record<string, unknown> = { today: todayISODate() };
  for (const key of dagNode(node)?.inputs ?? []) {
    const accessor = contextAccessors[key];
    if (!accessor) {
      console.warn(`leaf-regen-registry: no context accessor for "${key}" (input of "${node}")`);
      continue;
    }
    context[key] = accessor(client);
  }
  return context;
}

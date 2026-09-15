import Anthropic from "@anthropic-ai/sdk";
import type { Client, InferenceMode, MarkerGrouping } from "../src/lib/types";
import { systemOrder } from "@pablotech/akesi/system-groups";
import { MODELS } from "./inference-config";
import type { UsageAccumulator } from "./inference-cost";
import { distinctMarkerNames, markerGroupsHashOf, runMarkerGroupingPasses } from "@pablotech/akesi/marker-groups-prompt";
import { runGroupingPass } from "../src/lib/marker-groups-anthropic";

// W26 — partition EVERY distinct marker a patient has (all sources) into the body
// systems the AI Finding established (finding.disease[].group), so the Markers UI
// groups by System Analysis rather than by the lab panel an XLS import named. The
// group labels are the disease groups VERBATIM (the W25 pattern) plus a trailing
// "Not yet categorized" bucket; ordering downstream comes from systemOrder(), not
// from the model. Generalizes the former watchlist-only grouping.
//
// M95 — the prompt/schema/convergence-loop pieces live in src/lib/marker-groups-prompt.ts
// (isomorphic, shared with functions/api/refresh-marker-groups.ts); this file keeps only the
// Node-specific Anthropic singleton and the glue that turns one grouping pass into the
// injected `callModel`.

let cachedClient: Anthropic | null = null;
function anthropic(): Anthropic {
  if (cachedClient) return cachedClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Required to generate marker groups.");
  }
  cachedClient = new Anthropic();
  return cachedClient;
}

// One LLM grouping call over a given marker subset. Returns the raw model groups — the
// Node-specific half of the injected `callModel`; the request itself is built from the
// shared SYSTEM_PROMPT/GROUPS_SCHEMA/contextBlock.
// W64 — the CALL moved to src/lib/marker-groups-anthropic.ts, shared with the Pages Function.
async function groupingPass(
  client: Client,
  markers: string[],
  model: string,
  leftover: boolean,
  usage?: UsageAccumulator,
): Promise<{ group: string; markers: string[] }[]> {
  return runGroupingPass({
    anthropic: anthropic(),
    client,
    markers,
    model,
    leftover,
    onPass: (u) => usage?.record(model, u),
  });
}

export async function generateMarkerGroups(
  client: Client,
  model: string = MODELS.prod.ranges,
  mode: InferenceMode = "prod",
  usage?: UsageAccumulator,
): Promise<MarkerGrouping> {
  const systems = systemOrder(client);
  if (systems.length === 0) {
    throw new Error("no System Analysis (finding.disease) yet — run --refresh-finding first.");
  }

  const groups = await runMarkerGroupingPasses(client, systems, (markers, leftover) =>
    groupingPass(client, markers, model, leftover, usage),
  );
  if (groups.length === 0) throw new Error("marker grouping produced no groups");
  return {
    groups,
    markerGroupsHash: markerGroupsHashOf(distinctMarkerNames(client), systems),
    generatedAt: new Date().toISOString(),
    generatedBy: { mode, model },
  };
}

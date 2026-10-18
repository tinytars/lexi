// M59/Phase 2 — the Node/CLI edge of Ranges generation. The schema, prompt, and validation now
// live in src/lib/ranges-prompt.ts (pure, no process/factors-hash import) so the Pages Function
// (functions/api/refresh-range.ts) reuses them; this file keeps the model client from the inference config,
// factorsHashOf (Node:crypto), and the CLI call signature unchanged.
import type { Client, InferenceMode, PersonalizedRange } from "../src/lib/types";
import { factorsHashOf } from "./factors";
import { modelId } from "../src/lib/model-config";
import { modelFor } from "../functions/_lib/inference/resolve";
import type { UsageAccumulator } from "./inference-cost";
import { generateRange as runGenerateRange } from "../src/lib/ranges-anthropic";

export {
  RANGE_SCHEMA,
  systemPromptFor,
  validate,
  IMPERIAL_CONVERTS,
  type RangeAIResponse,
} from "@pablotech/akesi/ranges-prompt";

const anthropic = () => modelFor(process.env, "ranges").client;

// W64 — the CALL now lives in src/lib/ranges-anthropic.ts, shared with the Pages Function. This
// keeps what is genuinely CLI-side: the model client from the inference config, factorsHashOf (node:crypto),
// the UsageAccumulator, and the existing call signature. `unit` is accepted for compatibility with
// callers that pre-computed one and is IGNORED — the shared module derives it from the marker's
// latest reading, which is what the Function always did and the CLI did not.
export async function generateRange(
  marker: string,
  _unit: string,
  client: Client,
  model: string = modelId("ranges"),
  mode: InferenceMode = "prod",
  usage?: UsageAccumulator,
): Promise<PersonalizedRange> {
  const range = await runGenerateRange({
    anthropic: anthropic(),
    marker,
    client,
    model,
    mode,
    onUsage: (u) => usage?.record(model, u),
  });
  return { ...range, factorsHash: factorsHashOf(client) };
}

// M59/Phase 2 — the Node/CLI edge of Ranges generation. The schema, prompt, and validation now
// live in src/lib/ranges-prompt.ts (pure, no process/factors-hash import) so the Pages Function
// (functions/api/refresh-range.ts) reuses them; this file keeps the env-keyed Anthropic singleton,
// factorsHashOf (Node:crypto), and the CLI call signature unchanged.
import Anthropic from "@anthropic-ai/sdk";
import type { Client, InferenceMode, PersonalizedRange } from "../src/lib/types";
import { factorsHashOf } from "./factors";
import { MODELS } from "./inference-config";
import type { UsageAccumulator } from "./inference-cost";
import { generateRange as runGenerateRange } from "../src/lib/ranges-anthropic";

export {
  RANGE_SCHEMA,
  systemPromptFor,
  validate,
  IMPERIAL_CONVERTS,
  type RangeAIResponse,
} from "@pablotech/akesi-pil/ranges-prompt";

let cachedClient: Anthropic | null = null;
function anthropic(): Anthropic {
  if (cachedClient) return cachedClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Required to generate personalized ranges.");
  }
  cachedClient = new Anthropic();
  return cachedClient;
}

// W64 — the CALL now lives in src/lib/ranges-anthropic.ts, shared with the Pages Function. This
// keeps what is genuinely CLI-side: the env-keyed Anthropic singleton, factorsHashOf (node:crypto),
// the UsageAccumulator, and the existing call signature. `unit` is accepted for compatibility with
// callers that pre-computed one and is IGNORED — the shared module derives it from the marker's
// latest reading, which is what the Function always did and the CLI did not.
export async function generateRange(
  marker: string,
  _unit: string,
  client: Client,
  model: string = MODELS.prod.ranges,
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

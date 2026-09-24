// The one door every model call goes through: a feature name in, a client and model id out, built
// from inference.config.json and the env secrets it names.
import Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "@pablotech/akesi/model-client";
import { INFERENCE, modelId, providerFor, type Feature, type InferenceConfig } from "../../../src/lib/model-config";
import type { InferenceMode } from "../../../src/lib/types";
import { openAIClient } from "./openai";

export interface ResolvedModel {
  client: MessagesClient;
  model: string;
}

function keyFrom(env: object, names: string[]): string | undefined {
  const vars = env as Record<string, unknown>;
  for (const name of names) {
    const v = vars[name];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * Throws when the provider needs a key and none of its env vars is set, naming them.
 *
 * A route never calls this — it goes through `attach.ts`, which is the only place that pairs a model
 * with the reports it must answer from. What keeps it exported is `scripts/` and the benchmarks,
 * which run against files an operator already holds and have no session, no R2 and no client to
 * authorise; `tests/unit/inference-one-door.test.ts` is what enforces the route rule.
 */
export function modelFor(env: object, feature: Feature, mode: InferenceMode = "prod", config: InferenceConfig = INFERENCE): ResolvedModel {
  const provider = providerFor(feature, config);
  const apiKey = keyFrom(env, provider.keyEnv);
  if (!apiKey && provider.keyEnv.length > 0) {
    throw new Error(`model for "${feature}" is not configured: set ${provider.keyEnv.join(" or ")}`);
  }
  const client = provider.api === "anthropic" ? new Anthropic({ apiKey }) : openAIClient(provider, apiKey);
  return { client, model: modelId(feature, mode, config) };
}

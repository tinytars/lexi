import type { InferenceMode } from "../src/lib/types";

// Single source of truth for which model each inference uses in each mode.
// DEV = cheapest, for fast/cheap iteration. PROD = Opus, for the real deliverable.
// Edit this map to change models — it is the explicit configuration.
export const MODELS: Record<InferenceMode, { finding: string; ranges: string; report: string }> = {
  dev: { finding: "claude-sonnet-4-6", ranges: "claude-sonnet-4-6", report: "claude-sonnet-4-6" },
  prod: { finding: "claude-opus-4-7", ranges: "claude-opus-4-7", report: "claude-opus-4-7" },
};

// The weakest model available, used only by the retry-correction benchmark's failure-inducing
// regime — nothing the app ships runs on it. It lives here rather than inline so a model id still
// has exactly one home (tests/unit/model-ids-single-source.test.ts).
export const WEAKEST_MODEL = "claude-haiku-4-5-20251001";

// Safe default: PROD. Pass --mode dev (or INFERENCE_MODE=dev) to iterate cheaply.
export const DEFAULT_MODE: InferenceMode = "prod";

export function resolveMode(flag?: string): InferenceMode {
  const raw = (flag ?? process.env.INFERENCE_MODE ?? DEFAULT_MODE).toLowerCase();
  if (raw !== "dev" && raw !== "prod") {
    throw new Error(`invalid inference mode "${raw}" — expected "dev" or "prod"`);
  }
  return raw;
}

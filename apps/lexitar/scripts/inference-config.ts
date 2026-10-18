import type { InferenceMode } from "../src/lib/types";

// Safe default: PROD. Pass --mode dev (or INFERENCE_MODE=dev) to iterate cheaply.
export const DEFAULT_MODE: InferenceMode = "prod";

export function resolveMode(flag?: string): InferenceMode {
  const raw = (flag ?? process.env.INFERENCE_MODE ?? DEFAULT_MODE).toLowerCase();
  if (raw !== "dev" && raw !== "prod") {
    throw new Error(`invalid inference mode "${raw}" — expected "dev" or "prod"`);
  }
  return raw;
}

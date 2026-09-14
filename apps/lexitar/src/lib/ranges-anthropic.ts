// The Ranges generation call, in ONE place.
//
// Same split, and the same reason, as leaf-regen-anthropic.ts: "kept in one place so the CLI and the
// browser can never end up answering the same prompt two different ways." M59 extracted the prompt,
// the schema and the validator into ranges-prompt.ts — and then left the CALL duplicated. The two
// copies (functions/api/refresh-range.ts and scripts/claude-ranges.ts) drifted three ways:
//
//   1. The Function retried up to 3× on a transient failure or a schema miss; the CLI did not, so a
//      single 429 marked a marker permanently FAILED (ingest.ts's runOne).
//   2. The Function handled a DIMENSIONLESS ratio marker (unit ""); the CLI sent a bare "Unit: " and,
//      upstream, ingest.ts dropped any unitless marker before it ever got here. A ratio could be
//      Translated from the web and could never get a range from the CLI.
//   3. They picked the marker's unit differently — the Function from the LATEST row by date, the CLI
//      from whichever row happened to come first in `client.results`. For a marker whose assay unit
//      changed over time that is two different units, and therefore two ranges on different scales,
//      under a prompt whose own text says these values "disambiguate assay/unit scale".
//
// What stays with the callers: the Anthropic instance (env-keyed in the CLI, `env.RANGES_*` in the
// Function), the HTTP shell, usage accounting, and `factorsHash` — the two sides hash through
// different modules on purpose (see refresh-range.ts's note on module-graph isolation), so this
// returns the range unstamped and each caller stamps it.
import type Anthropic from "@anthropic-ai/sdk";
import type { Client, PersonalizedRange } from "./types";
import {
  systemPromptFor,
  rangesUserMessage,
  unitForMarker,
  RANGE_SCHEMA,
  validate,
  type RangeAIResponse,
} from "@pablotech/akesi-pil/ranges-prompt";
import { isRatioMarkerName } from "./marker-ratios";

export const RANGES_MAX_TOKENS = 1024;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [300, 900];

/** A schema failure, tagged so the retry ladder can tell "unusable model output — worth another
 *  generation" from a genuine transport error, without an `instanceof Anthropic.APIError` the tests
 *  cannot mock. */
export class RangeValidationError extends Error {}

/** The marker has no readings at all — distinct from a legitimately dimensionless one. */
export class NoMeasuredUnitError extends Error {}

export interface RangeRequest {
  anthropic: Anthropic;
  marker: string;
  client: Client;
  model: string;
  mode: "prod" | "dev";
  /** Called once per completed attempt, for cost accounting. */
  onUsage?: (usage: Anthropic.Message["usage"]) => void;
  /** Is this error worth another attempt? The Function classifies via its HTTP error taxonomy; the
   *  default covers the CLI, where a raw SDK error carries its own status. */
  isTransient?: (err: unknown) => boolean;
}

function defaultIsTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429 || status === 529 || status === 503;
}

export async function generateRange(req: RangeRequest): Promise<Omit<PersonalizedRange, "factorsHash">> {
  const { anthropic, marker, client, model, mode, onUsage } = req;
  const isTransient = req.isTransient ?? defaultIsTransient;
  const { unit, rows } = unitForMarker(client, marker);

  // A dimensionless ratio marker (e.g. DEXA's "Android/Gynoid % fat ratio") legitimately has no
  // unit — mirrors CriticalRatio.unit's "" convention in types.ts. Only a marker with NO readings,
  // or a non-ratio whose unit never resolved (an ingest gap), is an error.
  if (!unit && !(rows.length > 0 && isRatioMarkerName(marker))) {
    throw new NoMeasuredUnitError(`marker "${marker}" has no measured unit`);
  }

  const userMessage = rangesUserMessage(client, marker);

  async function once(): Promise<RangeAIResponse> {
    const response = await anthropic.messages.create({
      model,
      max_tokens: RANGES_MAX_TOKENS,
      system: [{ type: "text", text: systemPromptFor(client), cache_control: { type: "ephemeral" } }],
      output_config: { format: { type: "json_schema", schema: RANGE_SCHEMA } },
      messages: [{ role: "user", content: userMessage }],
    });
    onUsage?.(response.usage);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(
        `no text block in response for marker "${marker}" — stop_reason=${response.stop_reason}, types=${response.content.map((b) => b.type).join(",")}`,
      );
    }
    let parsed: RangeAIResponse;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      throw new RangeValidationError(`invalid JSON for marker "${marker}": ${textBlock.text.slice(0, 200)}`);
    }
    try {
      validate(marker, unit, parsed);
    } catch (e) {
      throw new RangeValidationError((e as Error).message);
    }
    return parsed;
  }

  let parsed: RangeAIResponse | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      parsed = await once();
      break;
    } catch (err) {
      const retryable = isTransient(err) || err instanceof RangeValidationError;
      if (attempt === MAX_ATTEMPTS || !retryable) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
  }

  const p = parsed!;
  const imp = p.explanationImperial?.trim();
  return {
    low: p.low ?? undefined,
    high: p.high ?? undefined,
    unit: p.unit,
    meaning: p.meaning.trim(),
    explanation: p.explanation.trim(),
    explanationImperial: imp ? imp : undefined,
    generalLow: p.generalLow ?? undefined,
    generalHigh: p.generalHigh ?? undefined,
    generalExplanation: p.generalExplanation.trim(),
    generatedAt: new Date().toISOString(),
    generatedBy: { mode, model },
  };
}

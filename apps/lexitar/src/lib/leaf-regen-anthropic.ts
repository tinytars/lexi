// The Anthropic-calling core of leaf-regen, extracted out of functions/api/leaf-regen.ts so a
// Node script (the treatmentAssessment backfill) can call it directly with an env API key instead
// of round-tripping through the session-gated relay, which has no CLI-usable auth. Kept in one
// place so the CLI and the browser can never end up answering the same prompt two different ways.
// functions/api/leaf-regen.ts stays the thin, session-gated HTTP wrapper: request parsing, body-size
// cap, and error→status-code mapping (classifyModelError) remain there, HTTP-specific.

import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "@pablotech/akesi/model-client";
import { LEAF_REGEN_SPECS, validateLeafResult } from "./leaf-regen-registry";
import { BASE_SYSTEM_PROMPT } from "./leaf-regen-prompts";
import { LEAF_REGEN_MAX_TOKENS } from "./leaf-regen-config";
import { documentsPromptBlock, type DocumentText } from "@pablotech/akesi/document-read";

// The SDK's own image media-type union. An attachment whose compression was skipped (the HEIC
// gotcha in attachment-store.ts) carries a mediaType the API cannot accept, and this used to be an
// unchecked cast — the request went out and came back as an opaque API error rather than the photo
// simply being left out.
const SDK_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type SdkImageType = (typeof SDK_IMAGE_TYPES)[number];

function sdkImageType(mediaType: string): SdkImageType | null {
  return (SDK_IMAGE_TYPES as readonly string[]).includes(mediaType) ? (mediaType as SdkImageType) : null;
}


// Clones toolSchema and rewrites its own (and its row-array property's) description so the tool
// definition agrees with a SCOPE OVERRIDE instead of contradicting it — see the scopeInstruction
// comment in runLeafRegen for why this is necessary, not just cosmetic.
function scopedToolSchema(toolSchema: Anthropic.Tool, arrayKey: string, scopeNote: string): Anthropic.Tool {
  const clone = JSON.parse(JSON.stringify(toolSchema)) as Anthropic.Tool;
  const inputSchema = clone.input_schema as { properties?: Record<string, { description?: string }> };
  const prop = inputSchema.properties?.[arrayKey];
  clone.description = `${clone.description} SCOPED for this call: emit ${scopeNote} ONLY, omitting every other row even if populated.`;
  if (prop) {
    prop.description = `${prop.description} SCOPED for this call: contains ${scopeNote} ONLY — no other row.`;
  }
  return clone;
}

export interface LeafRegenUsage {
  input: number;
  output: number;
}

export interface LeafRegenInvalidDebug {
  inputKeys: string[] | string;
  arrayLen: number | string;
  stopReason: string | null;
}

export type LeafRegenOutcome =
  | { kind: "empty" }
  | { kind: "ok"; result: unknown; usage: LeafRegenUsage }
  | { kind: "no_tool_use"; usage: LeafRegenUsage }
  /** The model hit max_tokens mid-answer. Terminal, not retryable — see the check in the attempt loop. */
  | { kind: "truncated"; usage: LeafRegenUsage }
  | { kind: "invalid"; error: Error; usage: LeafRegenUsage; debug: LeafRegenInvalidDebug };

export interface RunLeafRegenParams {
  client: MessagesClient;
  model: string;
  node: string;
  inputs: Record<string, unknown>;
  targetLabels?: string[];
  images?: { mediaType: string; base64: string }[];
  /** Extracted text of documents attached to THIS node's own rows — see finding-vision.ts's
   *  DOCUMENT_SOURCES for which nodes may have them, and why the monolith core may not. */
  documents?: DocumentText[];
  /** Aborts the generation when the caller goes away — see the request.signal pass-through in
   *  functions/api/leaf-regen.ts. Without it a browser disconnect leaves the model generating. */
  signal?: AbortSignal;
  /** The patient's own reports, prepended verbatim ahead of this node's inputs (CORPUS.md). Empty
   *  for the CLI backfill, which calls this in-process with no R2. Unchanged by the correction
   *  retry below, so the second attempt reads the cache entry the first one wrote. */
  prefixTurns?: Anthropic.MessageParam[];
}

// Throws on an unknown node (caller's responsibility to pass a valid one) or on an Anthropic SDK
// error (rate limit, credit exhaustion, etc.) — callers that need HTTP status mapping should wrap
// this in classifyModelError (functions/_lib/model-errors.ts) themselves, same as before.
export async function runLeafRegen(params: RunLeafRegenParams): Promise<LeafRegenOutcome> {
  const spec = LEAF_REGEN_SPECS[params.node];
  if (!spec) throw new Error(`no LEAF_REGEN_SPECS entry for node "${params.node}"`);

  // Nothing to regenerate → a no-op result is trivially valid; skip the billable call.
  //
  // A context built for the WRONG node reaches this line first, and every isEmpty indexes a key it
  // expects to be an array — so the failure used to read "Cannot read properties of undefined
  // (reading 'length')" with nothing naming the node or the cause. leafContextFor is the fix; this
  // says so if one ever slips past it again.
  let empty: boolean;
  try {
    empty = spec.isEmpty?.(params.inputs) ?? false;
  } catch {
    throw new Error(`leaf-regen(${params.node}): inputs do not match this node's context shape — build them with leafContextFor`);
  }
  if (empty) return { kind: "empty" };

  // M68 P4 — treatmentAssessment's targetLabels are the raw treatment name, not the model's own
  // dose-annotated "item" label (e.g. "Rosuvastatin" vs. "Rosuvastatin 20 mg"), so scoping for that
  // node must match on the row's primary drug/supplement name and ignore dose-annotation differences,
  // rather than requiring the verbatim match the other row-addressable nodes use.
  //
  // A scope note ONLY in the system prompt contradicts, rather than overrides, both (a) the node's
  // own systemPromptExtra, which spends many sentences instructing "emit one entry per EVERY
  // populated/present row", and (b) the tool schema's own row-array description, which says the
  // identical thing and is part of the model's function-calling contract. Under that contradiction
  // the model can default to trying to answer every row regardless of the trailing override, which
  // overruns max_tokens for a large list and comes back with an empty/invalid tool call. So the scope
  // note is (1) placed BEFORE spec.systemPromptExtra, as the first and most salient instruction for
  // this call, and (2) also patched into the tool schema itself via scopedToolSchema, so every
  // channel the model sees agrees on the same scope.
  const targetLabels = params.targetLabels;
  const scopeNote =
    targetLabels && targetLabels.length > 0
      ? params.node === "treatmentAssessment"
        ? `only the treatment(s) whose primary drug/supplement name matches, ignoring dose-annotation ` +
          `differences, one of: ${targetLabels.map((l) => `"${l}"`).join(", ")}`
        : `only the row(s), copied verbatim: ${targetLabels.map((l) => `"${l}"`).join(", ")}`
      : undefined;

  const scopeInstruction = scopeNote
    ? `SCOPE OVERRIDE for this request: everything below describes the full node — ignore any ` +
      `instruction there to answer every/each populated row. Emit an entry for ${scopeNote} ONLY. Do ` +
      `not include any other row, even if it is also populated.\n\n`
    : "";

  const toolSchema =
    scopeNote && spec.scopedArrayKey
      ? scopedToolSchema(spec.toolSchema as Anthropic.Tool, spec.scopedArrayKey, scopeNote)
      : (spec.toolSchema as Anthropic.Tool);

  // Image blocks (if any) lead, text last, mirroring report-extract.ts's document-then-text pattern;
  // plain string content when there are none (every node but the two vision-enabled ones, and those
  // two whenever the treatment/report row has no photo).
  //
  // Attached documents ride in the TEXT, not as document blocks: they were transcribed once at
  // attach time (document-read.ts) and re-sending the PDF on every regen would re-pay the whole
  // input for something already read. Text is also what a model can quote back.
  const documentsText = documentsPromptBlock(params.documents ?? []);
  const inputsText = documentsText ? `${documentsText}\n\n${JSON.stringify(params.inputs)}` : JSON.stringify(params.inputs);
  const images = (params.images ?? []).flatMap((img) => {
    const mediaType = sdkImageType(img.mediaType);
    // Drop, don't throw: the assessment is the deliverable and a photo the API cannot accept is an
    // enhancement — the same degradation leaf-regen-client.ts applies to an unfetchable blob.
    if (!mediaType) return [];
    return [{ mediaType, base64: img.base64 }];
  });
  const content: Anthropic.MessageParam["content"] = images.length
    ? [
        ...images.map((img): Anthropic.ImageBlockParam => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.base64 },
        })),
        { type: "text", text: inputsText },
      ]
    : inputsText;

  // 4096/8192 was sized for the scoped case — one row answered through a Translate button. It was
  // not enough to regenerate a WHOLE section, which is what the Finding refresh asks of these same
  // specs: measured on a real client, studyResults and noteResults both came back
  // stop_reason="max_tokens" (and so failed validation as a half-written tool call), while
  // treatmentAssessment survived on 3835 of 4096 — i.e. the scoped path was already one long drug
  // list away from silently truncating. The ceiling now fits the section, not the row
  // (LEAF_REGEN_MAX_TOKENS); only tokens actually produced are billed, so this costs nothing on the
  // small scoped calls.
  //
  // STREAMING is what makes that ceiling requestable at all: the SDK refuses a non-streaming request
  // whose max_tokens implies a >10-minute generation, which is exactly what capped this at 8192. It
  // also stops the Pages Function from buffering a long call behind a wall-clock cut with no in-band
  // way to report why. This is the first tool-use call in the repo to stream — the other .stream()
  // sites are plain text — but forced tool_choice is unaffected, and the tool block is read from
  // finalMessage() exactly as it was read from the non-streaming response.
  // W67 — ONE retry, with the rejection fed back. The id/coverage checks in validateLeafResult are
  // strict by design, and a leaf that trips one on a whole-Finding refresh used to lose its section
  // for the run: the orchestrator records the failure and moves on, so the only recovery was a human
  // clicking Translate. A single Sonnet re-ask is cents against a 19-minute run.
  //
  // ONE, not the core's six: the core's loop is what burned six full Opus generations on a real run
  // for no output. If a leaf cannot answer the same question twice, a third ask is not the fix.
  const attempt = async (correction?: string) => {
    const withCorrection =
      correction === undefined
        ? content
        : typeof content === "string"
          ? `${content}\n\n=== CORRECTION — your previous answer was REJECTED ===\n${correction}\nAnswer again, fixing this and keeping everything else valid.`
          : [
              ...content,
              {
                type: "text" as const,
                text: `\n\n=== CORRECTION — your previous answer was REJECTED ===\n${correction}\nAnswer again, fixing this and keeping everything else valid.`,
              },
            ];
    const stream = params.client.messages.stream(
      {
        model: params.model,
        max_tokens: LEAF_REGEN_MAX_TOKENS,
        system: `${BASE_SYSTEM_PROMPT}\n\n${scopeInstruction}${spec.systemPromptExtra}`,
        tools: [toolSchema],
        tool_choice: { type: "tool", name: toolSchema.name },
        messages: [...(params.prefixTurns ?? []), { role: "user", content: withCorrection }],
      },
      params.signal ? { signal: params.signal } : undefined,
    );
    return stream.finalMessage();
  };

  // Both attempts are billed, so both are reported — a retry that vanished from the cost line would
  // make the same mistake the core's loop made for a whole milestone.
  const usage = { input: 0, output: 0 };
  let last: LeafRegenOutcome | undefined;
  for (let i = 0; i < 2; i++) {
    const message = await attempt(i === 0 ? undefined : (last as { error: Error }).error.message.slice(0, 400));
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;

    // W75 — a truncated answer is its own outcome, checked BEFORE the tool block.
    //
    // This path never looked at stop_reason: it recorded it into `debug` and moved on, so hitting
    // max_tokens surfaced indirectly as a validation failure on a half-written tool call, and then
    // spent the single retry at the top of this loop on a request that truncates in exactly the same
    // place. Two billed calls, and an error message about shape for a problem about length. Every
    // other AI path in the app throws explicitly on this (marker-groups-anthropic.ts:45,
    // document-model.ts:80); this is the busiest one and it was the one that did not.
    if (message.stop_reason === "max_tokens") return { kind: "truncated", usage };

    const tool = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!tool) {
      last = { kind: "no_tool_use", usage };
      break; // nothing to correct — the model did not use the tool at all
    }

    try {
      return { kind: "ok", result: validateLeafResult(params.node, tool.input, params.inputs, targetLabels), usage };
    } catch (e) {
      // Debug aid for "items missing or not an array" reports — shape/metadata only (key names,
      // array length, stop_reason), never patient content, so this is safe under the "never log PHI"
      // rule (functions/_lib/log.ts). Caller decides whether/how to log it.
      const inputKeys = tool.input && typeof tool.input === "object" ? Object.keys(tool.input) : typeof tool.input;
      const arrKey = spec.scopedArrayKey;
      const arrVal = arrKey && tool.input && typeof tool.input === "object" ? (tool.input as Record<string, unknown>)[arrKey] : undefined;
      last = {
        kind: "invalid",
        error: e as Error,
        usage,
        debug: { inputKeys, arrayLen: Array.isArray(arrVal) ? arrVal.length : typeof arrVal, stopReason: message.stop_reason },
      };
    }
  }
  return last!;
}

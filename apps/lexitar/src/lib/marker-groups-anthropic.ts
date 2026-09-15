// One marker-grouping pass, shared by the CLI and the Pages Function.
//
// Same split as ranges-anthropic.ts and leaf-regen-anthropic.ts: marker-groups-prompt.ts already
// owned the schema, the system prompt, the context block and the multi-pass loop
// (`runMarkerGroupingPasses`) — but each side kept its own copy of the CALL, down to the same
// inline comment about `max_tokens: 8192` ("the full marker set … truncates at 2048"). The two had
// already begun to diverge in their error text.
//
// The differences that are real stay with the callers, as parameters: the Function passes an
// AbortSignal and enqueues a `[[PASS]] n` chunk into its stream; the CLI records usage into its
// accumulator. Everything else is one implementation.
import type Anthropic from "@anthropic-ai/sdk";
import type { Client } from "./types";
import { SYSTEM_PROMPT, GROUPS_SCHEMA, contextBlock, type GroupsAIResponse } from "@pablotech/akesi/marker-groups-prompt";

/** The full marker set echoes hundreds of names back; this truncates at 2048. */
export const MARKER_GROUPS_MAX_TOKENS = 8192;

export interface GroupingPassParams {
  anthropic: Anthropic;
  client: Client;
  markers: string[];
  model: string;
  /** True on the sweep-up pass for markers the first pass left unplaced. */
  leftover: boolean;
  signal?: AbortSignal;
  /** Called after each successful pass — usage accounting, and the Function's progress chunk. */
  onPass?: (usage: Anthropic.Message["usage"]) => void;
}

export async function runGroupingPass(p: GroupingPassParams): Promise<{ group: string; markers: string[] }[]> {
  const response = await p.anthropic.messages.create(
    {
      model: p.model,
      max_tokens: MARKER_GROUPS_MAX_TOKENS,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { format: { type: "json_schema", schema: GROUPS_SCHEMA } },
      messages: [
        { role: "user", content: `${contextBlock(p.client, p.markers, p.leftover)}\n\nReturn the body-system grouping as JSON.` },
      ],
    },
    p.signal ? { signal: p.signal } : undefined,
  );

  if (response.stop_reason === "max_tokens") {
    throw new Error("marker grouping truncated (max_tokens) — raise the limit; a partial grouping would silently mis-bucket markers.");
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error(`no text block in marker-groups response — stop_reason=${response.stop_reason}`);
  }
  p.onPass?.(response.usage);

  let parsed: GroupsAIResponse;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error(`invalid JSON for marker groups: ${textBlock.text.slice(0, 200)}`);
  }
  return parsed.groups ?? [];
}

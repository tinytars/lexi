// What this app says about akesi's Messages port beyond what the port itself states.
//
// The port is deliberately open at two points, and both are documented there rather than accidental:
// a request's turns are narrower than the SDK's own union (model-client.ts:60-68), and a stream event
// is opaque because akesi's own call cores keep the connection alive without reading deltas
// (model-client.ts:70-71). This app needs both statements made, so they are made once here instead of
// in the nine files that would otherwise each re-derive them.
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelRequest, StreamEvent } from "@pablotech/akesi/model-client";

/** A request's turn array, as the port takes it: user and assistant only. The SDK's `MessageParam`
 *  has admitted a system-role turn since 1.0, which is a turn this app never sends — `validateMessages`
 *  (functions/api/chat.ts) refuses one from the browser, and the system prompt rides in the request's
 *  own `system` field — so naming the port's type here is narrowing to what is actually sent rather
 *  than widening the port to a shape it would have to handle. */
export type ModelTurns = ModelRequest["messages"];
export type ModelTurn = ModelTurns[number];

/** The text of a content delta, or `undefined` for every other event. The two places that stream to a
 *  browser are the only readers of a delta in this codebase, so the narrowing against the SDK's own
 *  event union lives at the read and not in the port. */
export const textDelta = (event: StreamEvent): string | undefined => {
  const e = event as Anthropic.RawMessageStreamEvent;
  return e.type === "content_block_delta" && e.delta.type === "text_delta" ? e.delta.text : undefined;
};

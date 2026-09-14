import type { D1Database } from "../_lib/identity-types";
import Anthropic from "@anthropic-ai/sdk";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { classifyAnthropicError } from "../_lib/anthropic-errors";
// W76 — the declaration and its executor are ONE object. This route used to hand-copy the schema,
// under a comment claiming a Pages Function cannot import the CLI's tsconfig; chat-tools.ts is in
// src/lib, which twenty Functions already import from, and the copy had silently dropped the
// per-property descriptions and the "answer latest-value questions without a call" instruction —
// so the relayed schema was inviting billable tool calls the shared one discourages.
import { GET_MARKER_READINGS_TOOL } from "../../src/lib/chat-tools";
import { CHAT_MODEL } from "../../src/lib/chat-config";
// W76 — the prompt is shared, not inline, so brain-versions.test.ts can see it drift. Every other
// prompt in the app lives in a src/lib/*-prompt.ts under that stamp; this one was fifteen lines of
// clinical instruction — treatment-date causality, unit labelling, "do not diagnose" — authored in a
// route handler and invisible to the map whose whole argument is that a stale map is worse than none.
import { chatSystemPrompt } from "../../src/lib/chat-prompt";

interface Env {
  ANTHROPIC_API_KEY: string;
  SESSION_SECRET: string;
  // W71 — requireSession reads accounts.sessions_valid_from, so every gated route needs the binding.
  DB: D1Database;
}

const ROUTE = "/api/chat";


// Cap the running conversation the browser relays (tool rounds grow it). Generous vs a lean
// catalog + a few capped tool results; a runaway loop is stopped here, not billed to Claude.
// W46 Phase 6 — raised from 512 KB: a chat turn can now carry up to MAX_VISION_ATTACHMENTS
// (attachment-store.ts) compressed images as base64 (~100-200 KB each, ~1.4x inflated), riding
// alongside the same catalog+history payload — well under treatment-image-infer.ts's own 24 MB
// relay cap, since chat images are compressed client-side first.
const MAX_BODY_BYTES = 8 * 1024 * 1024;


// The running messages array the browser owns (history text turns + the catalog+question turn +
// any assistant tool_use / user tool_result rounds). Validated for shape + size at this boundary;
// the Function is a stateless relay and never inspects PHI inside content blocks.
function validateMessages(raw: unknown): Anthropic.MessageParam[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string" && !Array.isArray(content)) return null;
  }
  return raw as Anthropic.MessageParam[];
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const requestId = request.headers.get("cf-ray") ?? undefined;

  // Single exit point so every response is logged exactly once (no PHI — see log.ts).
  const finish = (status: number, payload: unknown, extra: Partial<Parameters<typeof logRequest>[0]> = {}): Response => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, requestId, ...extra });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    return finish(401, { error: "unauthorized" }, { errorCode: "unauthorized" });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return finish(413, { error: "conversation too large" }, { errorCode: "too_large" });
  }
  let body: { messages?: unknown; unitSystem?: unknown; final?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return finish(400, { error: "malformed JSON body" }, { errorCode: "bad_json" });
  }

  const messages = validateMessages(body.messages);
  if (!messages) {
    return finish(400, { error: "messages is required" }, { errorCode: "no_messages" });
  }

  // Stamped server-side so the model can apply treatment-date awareness.
  const today = new Date().toISOString().slice(0, 10);
  // The active measurement system; the context is already converted to it. Default US to
  // match the app's default selector (App.svelte) so an older client without the field aligns.
  const unitSystem = body.unitSystem === "metric" ? "metric" : "imperial";
  // On the final forced round the browser drops tools so the model must answer (loop-cap escape).
  const withTools = body.final !== true;

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 4096,
      system: chatSystemPrompt(today, unitSystem),
      ...(withTools ? { tools: [GET_MARKER_READINGS_TOOL] } : {}),
      messages,
    });
    const usage = { usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };

    if (message.stop_reason === "tool_use") {
      const toolUses = message.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      return finish(200, { kind: "tool_use", assistant: message.content, toolUses }, usage);
    }

    const answer = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    // W76 — a truncated or empty completion is an ERROR, not a short answer. `max_tokens` stops the
    // model mid-clause and `stop_reason` is the only thing that says so; a content set with no text
    // block at all renders as a blank reply. Both used to be returned as `kind: "answer"`, which is
    // the app telling a patient "here is your answer" about a sentence that stops halfway through a
    // number. Every other AI path here already refuses (marker-groups-anthropic.ts:45,
    // document-model.ts:81); this one is the one a patient reads directly.
    if (message.stop_reason === "max_tokens") {
      return finish(502, { error: "The answer was cut off before it finished — try a narrower question.", errorCode: "truncated" }, { ...usage, errorCode: "truncated" });
    }
    if (answer.trim() === "") {
      return finish(502, { error: "The assistant returned an empty answer.", errorCode: "empty_answer" }, { ...usage, errorCode: "empty_answer" });
    }
    return finish(200, { kind: "answer", answer }, usage);
  } catch (err) {
    // Distinguish credits-exhausted / rate-limit / overload from a generic failure
    // so the browser can show a recovery path (e.g. a billing link) — W7f.
    const { status, errorCode } = classifyAnthropicError(err);
    const messagesByCode: Record<string, string> = {
      insufficient_credit: "AI is temporarily unavailable: the account is out of credits.",
      ai_busy: "The AI is busy right now — try again in a moment.",
      anthropic_error: "chat backend error",
    };
    return finish(status, { error: messagesByCode[errorCode], errorCode }, { errorCode });
  }
}

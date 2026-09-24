import Anthropic from "@anthropic-ai/sdk";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { inferenceErrorReply } from "../_lib/model-errors";
import { attachedModelFor, type AttachedEnv } from "../_lib/inference/attach";
import { parseRawKeys } from "../../src/lib/raw-cipher";
// W76 — the declaration and its executor are ONE object. This route used to hand-copy the schema,
// under a comment claiming a Pages Function cannot import the CLI's tsconfig; chat-tools.ts is in
// src/lib, which twenty Functions already import from, and the copy had silently dropped the
// per-property descriptions and the "answer latest-value questions without a call" instruction —
// so the relayed schema was inviting billable tool calls the shared one discourages.
import { GET_MARKER_READINGS_TOOL } from "../../src/lib/chat-tools";
// W76 — the prompt is shared, not inline, so brain-versions.test.ts can see it drift. Every other
// prompt in the app lives in a src/lib/*-prompt.ts under that stamp; this one was fifteen lines of
// clinical instruction — treatment-date causality, unit labelling, "do not diagnose" — authored in a
// route handler and invisible to the map whose whole argument is that a stale map is worse than none.
import { chatSystemPrompt } from "../../src/lib/chat-prompt";

// AttachedEnv brings DB (which requireSession needs anyway, W71 — it reads
// accounts.sessions_valid_from), VAULT and STORE_PREFIX: the report corpus is read here, server-side.
interface Env extends AttachedEnv {
  SESSION_SECRET: string;
}

const ROUTE = "/api/chat";


// Cap the running conversation the browser relays (tool rounds grow it). Generous vs a lean
// catalog + a few capped tool results; a runaway loop is stopped here, not billed to Claude.
// W46 Phase 6 — raised from 512 KB: a chat turn can now carry up to MAX_VISION_ATTACHMENTS
// (attachment-store.ts) compressed images as base64 (~100-200 KB each, ~1.4x inflated), riding
// alongside the same catalog+history payload — well under treatment-image-infer.ts's own 24 MB
// relay cap, since chat images are compressed client-side first.
const MAX_BODY_BYTES = 8 * 1024 * 1024;


// The running messages array the browser owns (history text turns + the catalog+question turn + any
// assistant tool_use / user tool_result rounds). Validated for shape + size at this boundary; the
// Function never inspects PHI inside the browser's content blocks.
//
// It does, however, READ PHI now: the patient's own reports are fetched from R2 here and prepended
// as document blocks (CORPUS.md). "Stateless relay" stopped being true at that line — the route
// still does not look inside what the browser sent, but it is no longer a pass-through.
function validateMessages(raw: unknown): Anthropic.MessageParam[] | "document" | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string" && !Array.isArray(content)) return null;
    // The corpus is server-owned, and this is what makes that a property rather than a convention:
    // a document the browser supplies is unauthorised bytes riding in beside authorised ones. It
    // also cannot work — the browser replays the whole array on every tool round, and ~20 MB of
    // base64 per round does not fit MAX_BODY_BYTES once. `image` blocks stay allowed; that is the
    // attachment path.
    if (Array.isArray(content) && content.some((b) => (b as { type?: unknown })?.type === "document")) return "document";
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
  let body: { messages?: unknown; unitSystem?: unknown; final?: unknown; clientId?: unknown; rawKeys?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return finish(400, { error: "malformed JSON body" }, { errorCode: "bad_json" });
  }

  const messages = validateMessages(body.messages);
  if (!messages) {
    return finish(400, { error: "messages is required" }, { errorCode: "no_messages" });
  }
  if (messages === "document") {
    // These two carry their errorCode in the BODY, unlike the older validation replies above: both
    // mean the caller is built wrong, and the browser needs to tell them apart from a model failure.
    return finish(400, { error: "documents are attached by the server, not by the caller", errorCode: "client_document" }, { errorCode: "client_document" });
  }

  // Whose record this question is about — required, because the answer is assembled from that
  // person's reports and the account has to be entitled to read them.
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!clientId) {
    return finish(400, { error: "clientId is required", errorCode: "no_client_id" }, { errorCode: "no_client_id" });
  }

  // The active measurement system; the context is already converted to it. Default US to
  // match the app's default selector (App.svelte) so an older client without the field aligns.
  const unitSystem = body.unitSystem === "metric" ? "metric" : "imperial";
  // On the final forced round the browser drops tools so the model must answer (loop-cap escape).
  const withTools = body.final !== true;

  try {
    const { client, model, corpus } = await attachedModelFor(env, "chat", { accountId: session.accountId, clientId, rawKeys: parseRawKeys(body) });
    const message = await client.messages.create({
      model,
      max_tokens: 4096,
      system: chatSystemPrompt(unitSystem),
      ...(withTools ? { tools: [GET_MARKER_READINGS_TOOL] } : {}),
      // The corpus leads, identically on every tool round — that sameness is what the prompt cache
      // is keyed on, and what stops round 2 from re-reading 20 MB at full price.
      messages: [...corpus.turns, ...messages],
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
    // Spread, not destructured field-by-field: a corpus refusal carries `limit`/`actual`/`max` or
    // `unmeasured`, and those numbers are the whole remedy — "312 pages, at most 250" tells the
    // patient which reports to remove, where "too large" tells them nothing.
    const { status, ...payload } = inferenceErrorReply(err, "chat backend error");
    return finish(status, payload, { errorCode: payload.errorCode });
  }
}

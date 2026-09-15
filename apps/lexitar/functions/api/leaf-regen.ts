import type { D1Database } from "../_lib/identity-types";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { classifyAnthropicError } from "../_lib/anthropic-errors";
import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";
import { runLeafRegen } from "../../src/lib/leaf-regen-anthropic";
import { capDocuments } from "@pablotech/akesi/document-read";

// A TRANSLATE relay, in the owner's vocabulary (2026-08-21): this fills in LexiTar's reply to ONE
// turn. A user turn always gets its reply, so this is session-gated and nothing more — deliberately
// NOT behind PROVIDER_TOKEN. What that secret guards is "Translate all" (/api/refresh-finding), the
// whole-Finding regeneration. Briefly gating this route too meant a patient could add a note and
// never get an answer; see App.svelte, where the unprompted background sweep — neither a user turn
// nor a deliberate regen — is the one caller that does stay provider-only.
//
// W15d — the generic leaf-regen relay: one route for every LEAF_REGEN_SPECS entry, parameterized by
// `node`, modeled on /api/regroup's session-gate/body-cap/error-handling shape. Stateless like
// /api/regroup: the browser holds the decrypted vault, assembles the DAG-driven inputs client-side,
// this relay only calls Anthropic and validates the tool result — it never touches R2 or the
// passphrase. Runs on the distinct chat key + Sonnet tier (regroup-config), same as /api/regroup.
//
// The actual Anthropic call (scoped tool schema, system prompt, messages.create, validate) lives in
// src/lib/leaf-regen-anthropic.ts's runLeafRegen — shared with the treatmentAssessment backfill
// script (scripts/ingest.ts), which has no session cookie to send this relay and so calls it
// in-process instead. This file stays the thin, session-gated HTTP wrapper.
//
// Runs on RANGES_ANTHROPIC_API_KEY — the same key Markers' on-the-fly Translate uses
// (refresh-range.ts:89). Both secrets are set on the dev Pages project, but only the Ranges one is
// demonstrably good there: marker Translate works while every leaf-regen call came back
// anthropic_error, which points at the VALUE behind ANTHROPIC_API_KEY, not a missing binding.
// Keeps the old name as a fallback so any environment that only carries that one still works.
interface Env {
  RANGES_ANTHROPIC_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  SESSION_SECRET: string;
  // W71 — requireSession reads accounts.sessions_valid_from, so every gated route needs the binding.
  DB: D1Database;
}

const ROUTE = "/api/leaf-regen";
// W46 Phase 7 — raised from 256 KB: treatmentAssessment/diseaseResults can now carry up to
// MAX_VISION_ATTACHMENTS (attachment-store.ts) compressed images as base64 (~100-200 KB each,
// ~1.4x inflated) alongside the usual JSON inputs. Every other node's request stays tiny, well
// under the old cap, since only those two ever populate `images`.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const requestId = request.headers.get("cf-ray") ?? undefined;

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
    return finish(413, { error: "inputs too large" }, { errorCode: "too_large" });
  }
  let body: { node?: unknown; inputs?: unknown; targetLabels?: unknown; images?: unknown; documents?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return finish(400, { error: "malformed JSON body" }, { errorCode: "bad_json" });
  }

  if (typeof body.node !== "string") {
    return finish(400, { error: "node is required" }, { errorCode: "no_node" });
  }
  const spec = LEAF_REGEN_SPECS[body.node];
  if (!spec) {
    return finish(400, { error: `unknown node "${body.node}"` }, { errorCode: "unknown_node" });
  }
  if (!body.inputs || typeof body.inputs !== "object") {
    return finish(400, { error: "inputs is required" }, { errorCode: "no_inputs" });
  }
  const inputs = body.inputs as Record<string, unknown>;

  // Optional: for a row-addressable node (studyResults, treatmentAssessment — each item independently
  // identified by a label), the caller may narrow the response to just the row(s) that actually
  // changed instead of every populated row. Full context (inputs) is always sent unscoped, so
  // dedup/ordering/cross-row reasoning still works — only the requested OUTPUT count shrinks, which
  // is what keeps a large patient's response from truncating past max_tokens (see git history).
  let targetLabels: string[] | undefined;
  if (body.targetLabels !== undefined) {
    if (!Array.isArray(body.targetLabels) || !body.targetLabels.every((l) => typeof l === "string")) {
      return finish(400, { error: "targetLabels must be an array of strings" }, { errorCode: "bad_target_labels" });
    }
    targetLabels = body.targetLabels as string[];
  }

  // W46 Phase 7 — treatmentAssessment/diseaseResults only; the browser (finding-vision.ts's closed
  // whitelist) never sends this for any other node. Shape-validated, not re-checked against the
  // node whitelist here — this relay stays a dumb pass-through, same as it already trusts `inputs`.
  let images: { mediaType: string; base64: string }[] | undefined;
  if (body.images !== undefined) {
    const isImageArray = Array.isArray(body.images) && body.images.every(
      (i) => i && typeof (i as { mediaType?: unknown }).mediaType === "string" && typeof (i as { base64?: unknown }).base64 === "string",
    );
    if (!isImageArray) {
      return finish(400, { error: "images must be an array of {mediaType, base64}" }, { errorCode: "bad_images" });
    }
    images = body.images as { mediaType: string; base64: string }[];
  }

  // The extracted text of documents attached to this node's own rows (finding-vision.ts's
  // DOCUMENT_SOURCES decides which nodes may have them — the monolith core is absent from that map
  // and never calls this route). Shape-validated only, same pass-through discipline as `images`.
  let documents: { name: string; text: string }[] | undefined;
  if (body.documents !== undefined) {
    const isDocArray = Array.isArray(body.documents) && body.documents.every(
      (d) => d && typeof (d as { name?: unknown }).name === "string" && typeof (d as { text?: unknown }).text === "string",
    );
    if (!isDocArray) {
      return finish(400, { error: "documents must be an array of {name, text}" }, { errorCode: "bad_documents" });
    }
    // W75 — CAP here, not only in the browser. MAX_DOCUMENT_CHARS/MAX_DOCUMENTS_TOTAL_CHARS were
    // enforced in document-extract-client.ts alone, so a caller that is not this app's browser could
    // send text bounded only by MAX_BODY above. Same helper the browser calls, so the truncation
    // notice the model reads is identical either way.
    documents = capDocuments(body.documents as { name: string; text: string }[]);
  }

  // Nothing to regenerate → a no-op result is trivially valid; skip the billable call.
  try {
    const apiKey = env.RANGES_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY ?? "";
    // request.signal upstream (mirrors refresh-finding.ts): a browser that disconnects — a
    // navigation, or the client-side deadline firing — stops the generation instead of leaving
    // the model producing tokens nobody will read.
    const outcome = await runLeafRegen({ apiKey, node: body.node, inputs, targetLabels, images, documents, signal: request.signal });
    switch (outcome.kind) {
      case "empty":
        return finish(200, { result: null });
      case "truncated":
        // Distinct from no_tool_use on purpose: the model DID answer, and was cut off mid-tool-call.
        // Retrying identically truncates identically, so the honest answer is to say so and let the
        // caller narrow the request rather than bill a second doomed attempt.
        return finish(502, { error: "the model's answer was cut off before it finished", errorCode: "truncated" }, { errorCode: "truncated", usage: outcome.usage });
      case "no_tool_use":
        return finish(502, { error: "model did not emit the leaf-regen tool", errorCode: "no_tool_use" }, { errorCode: "no_tool_use", usage: outcome.usage });
      case "invalid":
        // Debug aid for the live "items missing or not an array" reports (2026-07-18, post-272b6c7) —
        // shape/metadata only (key names, array length, stop_reason), never patient content, so this
        // is safe under the "never log PHI" rule in _lib/log.ts.
        console.log(JSON.stringify({
          at: new Date().toISOString(),
          debug: "leaf-regen-invalid",
          node: body.node,
          scoped: targetLabels !== undefined && targetLabels.length > 0,
          ...outcome.debug,
          ...outcome.usage,
        }));
        return finish(422, { error: outcome.error.message, errorCode: "invalid_leaf_regen" }, { errorCode: "invalid_leaf_regen", usage: outcome.usage });
      case "ok":
        return finish(200, { result: outcome.result }, { usage: outcome.usage });
    }
  } catch (err) {
    const { status, errorCode } = classifyAnthropicError(err);
    const messagesByCode: Record<string, string> = {
      insufficient_credit: "AI is temporarily unavailable: the account is out of credits.",
      ai_busy: "The AI is busy right now — try again in a moment.",
      anthropic_error: "leaf-regen backend error",
    };
    return finish(status, { error: messagesByCode[errorCode], errorCode }, { errorCode });
  }
}

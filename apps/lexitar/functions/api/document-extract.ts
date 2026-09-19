import type { D1Database } from "../_lib/identity-types";
import { recordRawObject } from "../_lib/identity-audit";
import Anthropic from "@anthropic-ai/sdk";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { classifyAnthropicError } from "../_lib/anthropic-errors";
import { storeKey } from "../_lib/store";
import { rawAccessFor, type RawAccess } from "../_lib/raw-owner";
import { readDocument, DOCUMENT_READ_FAILURE, type DocumentReading, type StoredExtraction } from "@pablotech/akesi/document-read";
import { EXTRACT_MODEL } from "../../src/lib/extract-config";
import type { ObjectBucket } from "../_lib/object-bucket";

// Read one ALREADY-UPLOADED attachment as text, and cache the result forever.
//
// The request carries only {id, key} — never the bytes. The browser has already PUT the file to
// /api/raw/{id}/{key}, and attachment keys are content-addressed ("<sha8>-<name>",
// attachment-store.ts), so the blob key IS the cache key: re-attaching the same bytes, from any
// surface, hits the sidecar and never bills a second extraction. Sending the base64 back up would
// have re-paid an ~18 MB upload per attachment for no benefit.
//
// The extracted text is stored as an R2 SIDECAR (text/{id}/{key}.json), not in the vault. A long
// PDF's transcription in a vault blob would be re-encrypted and rewritten on every unrelated edit;
// the vault keeps metadata only (Attachment.extracted, types.ts). The sidecar is plaintext PHI in
// exactly the same sense raw/ already is, under the same session gate, in the same bucket.

interface Env {
  VAULT: Pick<ObjectBucket, "get" | "put">;
  ANTHROPIC_API_KEY?: string;
  RANGES_ANTHROPIC_API_KEY?: string;
  SESSION_SECRET: string;
  // W71 — requireSession reads accounts.sessions_valid_from, so every gated route needs the binding.
  DB: D1Database;
  STORE_PREFIX: string;
}

const ROUTE = "/api/document-extract";
const MAX_BODY_BYTES = 8 * 1024;
// Mirrors /api/extract's ceiling: a base64 PDF inflates ~33%, so ~18 MB of PDF is the most Claude
// will take as a document block.
const MAX_DOCUMENT_BYTES = 18 * 1024 * 1024;

/** A file we can read WITHOUT a model call — the bytes already are the text. */
function isPlainText(file: string, mediaType?: string): boolean {
  return /\.(txt|md|markdown)$/i.test(file) || (mediaType ?? "").startsWith("text/");
}

function isPdf(file: string, mediaType?: string): boolean {
  return /\.pdf$/i.test(file) || mediaType === "application/pdf";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked — String.fromCharCode(...bytes) on a multi-MB array overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

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
    return finish(413, { error: "request too large", errorCode: "too_large" }, { errorCode: "too_large" });
  }
  let body: { id?: unknown; key?: unknown; mediaType?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return finish(400, { error: "malformed JSON body", errorCode: "bad_json" }, { errorCode: "bad_json" });
  }

  const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const mediaType = typeof body.mediaType === "string" ? body.mediaType : undefined;
  // Same path discipline as /api/raw: no traversal, no empties — these become R2 key segments.
  if (!id || !key || id.includes("/") || key.includes("/") || key === "." || key === "..") {
    return finish(400, { error: "id and key are required", errorCode: "bad_path" }, { errorCode: "bad_path" });
  }
  if (!isPdf(key, mediaType) && !isPlainText(key, mediaType)) {
    return finish(415, { error: "only PDF and plain-text documents can be read", errorCode: "unsupported_document" }, { errorCode: "unsupported_document" });
  }

  // W73 (SECURITY.md gap 1). This route was the cleanest oracle of the two: its cache branch below
  // returns another patient's EXTRACTED PLAINTEXT before it ever touches raw/, so a cross-tenant read
  // cost nothing and billed nothing. The check therefore goes above the cache, not beside the fetch.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (access.kind === "denied") {
    return finish(404, { error: "not found", errorCode: "not_found" }, { errorCode: "not_found" });
  }

  const sidecarKey = storeKey(env, "text", id, `${key}.json`);

  // Cache first — the whole point of content-addressed keys.
  const cached = await env.VAULT.get(sidecarKey);
  if (cached) {
    try {
      const parsed = JSON.parse(await cached.text()) as StoredExtraction;
      return finish(200, { ...parsed, cached: true }, { access: access.kind });
    } catch {
      // A corrupt sidecar re-extracts rather than failing the request; the put below overwrites it.
    }
  }

  const raw = await env.VAULT.get(storeKey(env, "raw", id, key));
  if (!raw) {
    return finish(404, { error: "attachment not found", errorCode: "not_found" }, { errorCode: "not_found" });
  }
  const bytes = new Uint8Array(await raw.arrayBuffer());

  let reading: DocumentReading;
  let model: string | undefined;
  try {
    if (isPlainText(key, mediaType)) {
      // No model call at all — free, and the common case for a pasted protocol or an exported note.
      const text = new TextDecoder().decode(bytes);
      if (!text.trim()) {
        return finish(422, { error: "this document is empty", errorCode: "invalid_extraction" }, { errorCode: "invalid_extraction" });
      }
      reading = { documentKind: "Text document", isMedicalReport: false, notReportReason: "plain text, not a clinical report", text };
    } else {
      if (bytes.length > MAX_DOCUMENT_BYTES) {
        return finish(413, { error: "document too large to read", errorCode: "too_large" }, { errorCode: "too_large" });
      }
      const apiKey = env.RANGES_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY ?? "";
      model = EXTRACT_MODEL;
      reading = await readDocument(new Anthropic({ apiKey }), { pdfBase64: bytesToBase64(bytes) }, key, model);
    }
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (DOCUMENT_READ_FAILURE.test(message)) {
      return finish(422, { error: "could not read this document", detail: message, errorCode: "invalid_extraction" }, { errorCode: "invalid_extraction" });
    }
    const { status, errorCode } = classifyAnthropicError(err);
    const messagesByCode: Record<string, string> = {
      insufficient_credit: "AI is temporarily unavailable: the account is out of credits.",
      ai_busy: "The AI is busy right now — try again in a moment.",
      anthropic_error: "document reading backend error",
    };
    return finish(status, { error: messagesByCode[errorCode] ?? "document reading backend error", errorCode }, { errorCode });
  }

  const stored: StoredExtraction = {
    ...reading,
    at: new Date().toISOString(),
    chars: reading.text.length,
    ...(model ? { model } : {}),
  };
  await env.VAULT.put(sidecarKey, JSON.stringify(stored));
  // W72 — the sidecar is extracted PLAINTEXT PHI, so it is erasable data in its own right and gets the
  // same ownership row the original does. Without it an erasure would delete the PDF and leave its
  // readable text behind, which is the worst of the two outcomes.
  await recordRawObject(env.DB, sidecarKey, session.accountId);
  // W8d: audit the write — id + size, never the content.
  return finish(200, { ...stored, cached: false }, { bytes: stored.chars, access: access.kind });
}

// GET /api/document-extract?id=&key= — the sidecar only, never a model call. This is what a leaf
// turn or a chat send uses to pick up text that was extracted at attach time: it must be cheap and
// must never silently start an extraction as a side effect of rendering.
export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, extra: { errorCode?: string; access?: RawAccess["kind"] } = {}) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, ...extra });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, { errorCode: "unauthorized" });
    return session;
  }
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") ?? "").trim().toLowerCase();
  const key = (url.searchParams.get("key") ?? "").trim();
  if (!id || !key || id.includes("/") || key.includes("/")) {
    log(400, { errorCode: "bad_path" });
    return new Response(JSON.stringify({ error: "id and key are required" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const readAccess = await rawAccessFor(env.DB, env, session.accountId, id);
  if (readAccess.kind === "denied") {
    log(404, { errorCode: "not_owner" });
    return new Response(JSON.stringify({ error: "not found", errorCode: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
  }

  const cached = await env.VAULT.get(storeKey(env, "text", id, `${key}.json`));
  if (!cached) {
    log(404, { errorCode: "not_found", access: readAccess.kind });
    return new Response(JSON.stringify({ error: "not extracted" }), { status: 404, headers: { "content-type": "application/json" } });
  }
  log(200, { access: readAccess.kind });
  return new Response(await cached.text(), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

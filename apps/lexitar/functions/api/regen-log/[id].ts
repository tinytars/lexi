import type { D1Database } from "../../_lib/identity-types";
import { recordRawObject } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { storeKey } from "../../_lib/store";
import { rawAccessFor, mayRead, mayWrite, type RawAccess } from "../../_lib/raw-owner";
import { json } from "../../_lib/http";
import { listAllKeys, type ObjectBucket } from "../../_lib/object-bucket";

// W87 — the regen log, moved out of the vault blob.
//
// WHY THIS ROUTE EXISTS. `Client.regenLog` is append-only evidence: every leaf regeneration stores
// the before and after text of each Finding section it rewrote. It lived inside the vault blob,
// which is re-encrypted and re-uploaded WHOLE on every unrelated edit, so a record accumulated
// megabytes that every save had to carry — one record reached 5,163,393 bytes, 98.5% of
// /api/vault/{id}'s 5 MB ceiling, and the next save after that could not be stored at all. The log
// has one writer and zero readers (src/lib/leaf-regen-client.ts:184), so what the patient actually
// lost was the ability to save their record, in exchange for carrying evidence nothing read.
//
// src/lib/regen-log.ts:14-18 wrote down what to do about it before it happened, and it is why this
// is a relocation rather than a retention cap: "If size becomes the binding constraint the answer
// is to move the log out of the vault — a migration, which is recoverable, rather than a
// truncation, which is not."
//
// WHY A SEGMENT PER WRITE, AND NOT ONE BLOB LIKE /api/chat-history. Chat history is read, merged
// and rewritten because a thread is EDITED, which is what buys that route its etag, its 412 and its
// re-read-and-merge. A regen event is never edited. So each write is its own immutable object and
// this route needs no precondition, no conflict, no merge and no unreadable-blob escape hatch — and
// append stays O(1) in the size of the log forever, where a single blob would put the whole history
// back on the wire, and in the Worker's isolate memory, on every append.
//
// The client does not choose the key. The server mints `{iso}-{rand}.enc`, so a client cannot
// overwrite an earlier segment or write outside its own namespace, and the name sorts by time.

interface Env {
  VAULT: Pick<ObjectBucket, "get" | "put" | "list">;
  SESSION_SECRET: string;
  DB: D1Database;
  STORE_PREFIX: string;
}

interface Ctx {
  request: Request;
  env: Env;
  params: { id: string };
}

const ROUTE = "/api/regen-log";
const MIN_BYTES = 32; // MAGIC(3) + VERSION(1) + SALT(16) + IV(12) — mirrors decryptVault
// Generous because the FIRST segment every existing record writes is its whole in-vault log at once,
// and the largest measured on dev is ~5 MB of it. Steady-state segments are one regen each.
const MAX_BYTES = 8 * 1024 * 1024;
const HD1 = [0x48, 0x44, 0x31]; // "HD1" — the in-browser crypto magic prefix

const prefix = (env: Env, id: string) => `${storeKey(env, "regen-log", id)}/`;

/** A minted segment name: time-sortable, collision-proof, and containing nothing a client supplied. */
function mintSegment(now = new Date()): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${now.toISOString().replace(/[:.]/g, "-")}-${rand}.enc`;
}

/**
 * Exactly what mintSegment produces and nothing else. A GET's `?segment=` is the one place a
 * caller-supplied string reaches a key, so it is matched against the minted shape rather than
 * merely checked for `..` or `/` — a denylist admits whatever nobody thought of.
 */
export const isSegmentName = (s: string): boolean => /^\d{4}-\d{2}-\d{2}T[\dA-Za-z-]+-[0-9a-f]{8}\.enc$/.test(s);

// PUT — append one already-encrypted HD1 segment. Guarded; never decrypts.
export async function onRequestPut(context: Ctx): Promise<Response> {
  const { request, env, params } = context;
  const start = Date.now();
  const id = params.id;
  const log = (status: number, extra: { errorCode?: string; bytes?: number; access?: RawAccess["kind"] } = {}) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, id, ...extra });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, { errorCode: "unauthorized" });
    return session;
  }

  // The same client-key namespace as raw/, text/ and chat-, so the same ownership question answered
  // by the same helper (functions/_lib/raw-owner.ts). An EMPTY namespace is writable for the reason
  // it is on raw/: a patient whose first regen predates any attachment has claimed nothing yet.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (!mayWrite(access)) {
    log(404, { errorCode: access.kind === "denied" ? "not_owner" : access.kind, access: access.kind });
    return json(404, { error: "not found" });
  }

  const blob = new Uint8Array(await request.arrayBuffer());
  if (blob.length > MAX_BYTES) {
    log(413, { errorCode: "too_large" });
    return json(413, { error: "regen log segment too large", bytes: blob.length, max: MAX_BYTES });
  }
  if (blob.length < MIN_BYTES || blob[0] !== HD1[0] || blob[1] !== HD1[1] || blob[2] !== HD1[2]) {
    log(400, { errorCode: "not_hd1" });
    return json(400, { error: "not an HD1 blob" });
  }

  const segment = mintSegment();
  const key = `${prefix(env, id)}${segment}`;
  await env.VAULT.put(key, blob);
  // Claim the namespace on a successful write, so this client's regen log, chat, originals and
  // extracted text all answer to the same owner. INSERT OR IGNORE, so a re-save never reassigns it.
  await recordRawObject(env.DB, key, session.accountId);

  log(201, { bytes: blob.length, access: access.kind }); // id + size, never the bytes
  return json(201, { segment });
}

// GET — the segment names, or one segment's ciphertext with `?segment=`. 404 on an unwritten log.
export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env, params } = context;
  const start = Date.now();
  const id = params.id;
  const log = (status: number, extra: { errorCode?: string; access?: RawAccess["kind"] } = {}) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, id, ...extra });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, { errorCode: "unauthorized" });
    return session;
  }

  // Only the owner or a live grant reads (W76) — the gate /api/chat-history was missing until W71,
  // and the one this namespace needs for the same reason: ciphertext keyed by a guessable slug.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (!mayRead(access)) {
    log(404, { errorCode: access.kind === "denied" ? "not_owner" : access.kind, access: access.kind });
    return json(404, { error: "not found" });
  }

  const wanted = new URL(request.url).searchParams.get("segment");
  if (wanted !== null) {
    if (!isSegmentName(wanted)) {
      log(400, { errorCode: "bad_segment" });
      return json(400, { error: "not a segment name" });
    }
    const obj = await env.VAULT.get(`${prefix(env, id)}${wanted}`);
    if (!obj) {
      log(404, { errorCode: "not_found", access: access.kind });
      return json(404, { error: "segment not found" });
    }
    log(200, { access: access.kind });
    return new Response(obj.body, {
      status: 200,
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store", etag: obj.etag },
    });
  }

  // listAllKeys and not list(): one page read as the whole answer has already cost this project a
  // silent backup failure and a false `complete: true` erasure (W73).
  const keys = await listAllKeys(env.VAULT, prefix(env, id));
  const segments = keys.map((k) => k.slice(prefix(env, id).length)).sort();
  log(200, { access: access.kind });
  return json(200, { segments });
}

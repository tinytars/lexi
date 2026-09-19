import type { D1Database } from "../../_lib/identity-types";
import { recordRawObject } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { storeKey } from "../../_lib/store";
import { rawAccessFor, type RawAccess } from "../../_lib/raw-owner";
import { json } from "../../_lib/http";

// W16 — per-client chat history: an in-browser-encrypted HD1 blob (Thread[] as ciphertext).
// Never decrypts; no static seed — a first GET simply 404s and the browser starts fresh.
//
// W71 corrects two things this comment used to claim. PUT is NOT bearer-guarded, it is
// session-guarded (and has been since W44) — a comment describing a gate the code does not have is
// worse than no comment, because it is what a reviewer checks instead of the code. And GET was not
// merely "open like the vault GET": it had no gate AT ALL, where /api/vault/{id} at least offers a
// bearer and falls back to a session + envelope check. That made this an unauthenticated
// PHI-ciphertext read keyed by a guessable slug — useless without the passphrase, but a standing
// offline-attack target that a patient could neither see nor revoke. It now needs a session.
//
// PUT also takes the If-Match concurrency /api/vault gained in W70. It is the same blob-replacing
// write with the same two-tab lost-update bug, one directory away from the fix.

interface R2ObjectBody {
  body: ReadableStream;
  etag: string;
}
interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  /** Returns the stored object (with its NEW etag), or null when an `onlyIf` precondition fails. */
  put(key: string, value: Uint8Array, options?: { onlyIf?: R2Conditional }): Promise<{ etag: string } | null>;
}
interface Env {
  VAULT: R2Bucket;
  SESSION_SECRET: string;
  // W71 — requireSession reads accounts.sessions_valid_from, so every gated route needs the binding.
  DB: D1Database;
  STORE_PREFIX: string;
}

interface Ctx {
  request: Request;
  env: Env;
  params: { id: string };
}

const ROUTE = "/api/chat-history";
const MIN_BYTES = 32; // MAGIC(3) + VERSION(1) + SALT(16) + IV(12) — mirrors decryptVault
const MAX_BYTES = 2 * 1024 * 1024; // conversations are text; a generous ceiling / loop backstop
const HD1 = [0x48, 0x44, 0x31]; // "HD1" — the in-browser crypto magic prefix

const r2Key = (env: Env, id: string) => storeKey(env, `chat-${id}.enc`);

/** An `If-Match` header value is quoted (`"abc"`); R2's etagMatches wants the bare token. */
const unquote = (v: string): string => v.trim().replace(/^W\//, "").replace(/^"|"$/g, "");

// PUT — store an already-encrypted HD1 blob. Guarded; never decrypts.
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

  // W73 (SECURITY.md gap 2) — the same client-key namespace as raw/ and text/, so the same ownership
  // question, answered by the same helper. Until now any authenticated account could overwrite any
  // client's chat history. UNCLAIMED is allowed on PUT for the same reason it is on raw/: a patient
  // whose first chat predates any attachment has claimed nothing yet.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (access.kind === "denied") {
    log(404, { errorCode: "not_owner" });
    return json(404, { error: "not found" });
  }

  const blob = new Uint8Array(await request.arrayBuffer());
  if (blob.length > MAX_BYTES) {
    log(413, { errorCode: "too_large" });
    return json(413, { error: "chat history too large" });
  }
  if (blob.length < MIN_BYTES || blob[0] !== HD1[0] || blob[1] !== HD1[1] || blob[2] !== HD1[2]) {
    log(400, { errorCode: "not_hd1" });
    return json(400, { error: "not an HD1 blob" });
  }

  // Mirrors /api/vault/{id}. Unlike the vault this does NOT 428 on a missing precondition: chat
  // history is append-mostly and a client that has never read the blob has no etag to send, so
  // requiring one would refuse the first save of every fresh conversation. A precondition is honoured
  // whenever it is offered, which is the case the lost update actually comes from.
  const ifMatch = request.headers.get("if-match");
  const onlyIf: R2Conditional | undefined =
    ifMatch && ifMatch !== "*"
      ? { etagMatches: unquote(ifMatch) }
      : request.headers.get("if-none-match") === "*"
        ? { etagDoesNotMatch: "*" }
        : undefined;

  const written = onlyIf ? await env.VAULT.put(r2Key(env, id), blob, { onlyIf }) : await env.VAULT.put(r2Key(env, id), blob);
  // W73 — claim the namespace on a successful write, so this client's chat, originals and extracted
  // text all answer to the same owner. INSERT OR IGNORE, so a re-save never reassigns it.
  if (written) await recordRawObject(env.DB, r2Key(env, id), session.accountId);
  if (!written) {
    // The blob moved under us. Hand back the CURRENT etag so the client resolves in one round trip.
    const current = await env.VAULT.get(r2Key(env, id));
    log(412, { errorCode: "precondition_failed" });
    return new Response(JSON.stringify({ error: "chat history changed since it was read" }), {
      status: 412,
      headers: { "content-type": "application/json", ...(current ? { etag: current.etag } : {}) },
    });
  }

  log(204, { bytes: blob.length, access: access.kind }); // W8d: audit the write — id + size, never the bytes
  return new Response(null, { status: 204, headers: { etag: written.etag } });
}

// GET — return the already-encrypted blob. 404 on a first-ever load.
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

  // W75 — this comment used to say a READ of an unclaimed namespace was refused where a write is not.
  // It never was, and it should not be: a chat blob written before ownership recording began is
  // unclaimed for precisely the patients the backfill cannot attribute, and refusing them the read
  // would hand them an empty conversation whose next save overwrites their real history. The blob is
  // ciphertext either way — strictly less exposure than raw/, where the same rule already stands. What
  // this route does refuse is a namespace someone else owns; the unclaimed residual is logged below.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (access.kind === "denied") {
    log(404, { errorCode: "not_owner" });
    return json(404, { error: "not found" });
  }

  const obj = await env.VAULT.get(r2Key(env, id));
  if (obj) {
    log(200, { access: access.kind });
    return new Response(obj.body, {
      // The etag is the client's If-Match token for its next save.
      status: 200,
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store", etag: obj.etag },
    });
  }
  log(404, { errorCode: "not_found", access: access.kind });
  return json(404, { error: "chat history not found" });
}

import type { D1Database } from "../../_lib/identity-types";
import { recordRawObject } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { normalizeClientId } from "../../../src/lib/client-id";
import { storeKey } from "../../_lib/store";
import { rawAccessFor, mayDestroy, type RawAccess } from "../../_lib/raw-owner";

// W13d — GET /api/raw/{id}/{file}: stream an original raw source (PDF/XLSX) from R2.
// Raw originals are PLAINTEXT PHI, so unlike the open /api/vault .enc GET this is
// SESSION-GATED, then authorised per record: requireSession establishes who is asking and
// rawAccessFor decides whether they may have THIS id (W73). The Function never decrypts —
// raw is stored unencrypted under {store}/raw/{id}/, gated only by that pair.

interface R2ObjectBody {
  body: ReadableStream;
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(key: string): Promise<void>;
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
  params: { path?: string[] };
}

const ROUTE = "/api/raw";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const contentTypeFor = (file: string): string => {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === "xls") return "application/vnd.ms-excel";
  if (ext === "json") return "application/json";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  // W46 — attachments generalize raw storage beyond treatment photos (jpeg/png only, always
  // compressed client-side); a stored-original-on-HEIC-decode-failure fallback or a directly
  // attached webp/gif needs its own content-type.
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "gif") return "image/gif";
  return "application/octet-stream";
};

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env, params } = context;
  const start = Date.now();
  const segs = params.path ?? [];
  const id = segs[0];
  const file = segs.slice(1).join("/");
  const log = (status: number, extra: { errorCode?: string; bytes?: number; access?: RawAccess["kind"] } = {}) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, id, ...extra });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, { errorCode: "unauthorized" });
    return session;
  }

  // {id}/{file} required; reject path traversal / empties (segments can't contain "/").
  if (!id || !file || segs.some((s) => s === "" || s === "." || s === "..")) {
    log(400, { errorCode: "bad_path" });
    return json(400, { error: "expected /api/raw/{id}/{file}" });
  }

  // R2 raw keys are lowercase; a vault client key predating G1 may not be.
  // W73 (SECURITY.md gap 1) — authenticated is not authorised. Until now `session.accountId` was read
  // and never compared to anything, so any signed-up account could fetch another patient's plaintext
  // PDFs. 404 rather than 403 for a namespace that is not yours: a 403 would confirm the object exists.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (access.kind === "denied") {
    log(404, { errorCode: "not_owner" });
    return json(404, { error: "not found" });
  }

  const obj = await env.VAULT.get(storeKey(env, "raw", normalizeClientId(id), file));
  if (!obj) {
    log(404, { errorCode: "not_found", access: access.kind });
    return json(404, { error: "raw source not found" });
  }

  log(200, { access: access.kind });
  return new Response(obj.body, {
    status: 200,
    headers: { "content-type": contentTypeFor(file), "cache-control": "no-store" },
  });
}

// W15/1 — PUT /api/raw/{id}/{file}: store an uploaded original (PDF/XLSX) in R2
// (session-gated + per-record authorised, same as GET). The browser web-ingest flow uploads the raw
// bytes here after hashing; the stored copy backs the download button and, via the
// reconciler (W15/2b), the git plaintext survival copy. Raw is plaintext PHI by
// design — no HD1 check. Path/guard logic mirrors onRequestGet; idempotent (a re-PUT
// of the same content-addressed file is a harmless overwrite).
const MAX_RAW_BYTES = 24 * 1024 * 1024;
export async function onRequestPut(context: Ctx): Promise<Response> {
  const { request, env, params } = context;
  const start = Date.now();
  const segs = params.path ?? [];
  const id = segs[0];
  const file = segs.slice(1).join("/");
  const log = (status: number, extra: { errorCode?: string; bytes?: number; access?: RawAccess["kind"] } = {}) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, id, ...extra });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, { errorCode: "unauthorized" });
    return session;
  }
  if (!id || !file || segs.some((s) => s === "" || s === "." || s === "..")) {
    log(400, { errorCode: "bad_path" });
    return json(400, { error: "expected /api/raw/{id}/{file}" });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_RAW_BYTES) {
    log(413, { errorCode: "too_large" });
    return json(413, { error: "raw source too large" });
  }
  if (bytes.length === 0) {
    log(400, { errorCode: "empty" });
    return json(400, { error: "empty body" });
  }

  // An UNCLAIMED namespace is allowed through: that is how a new client's first upload has always
  // worked, and recordRawObject below makes this caller its owner. A claimed one must be theirs, or
  // an attacker could squat a key inside someone else's folder and own it forever.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (access.kind === "denied") {
    log(404, { errorCode: "not_owner" });
    return json(404, { error: "not found" });
  }

  const key = storeKey(env, "raw", normalizeClientId(id), file);
  await env.VAULT.put(key, bytes);
  // W72 — record who wrote it. The key carries a client DISPLAY NAME, which lives only inside the
  // encrypted vault, so without this row the server can never afterwards say whose object this is —
  // which is why erasure could not promise to delete a patient's originals. Written after the put, so
  // a failed upload leaves no ownership claim; INSERT OR IGNORE, so a re-PUT does not reassign it.
  await recordRawObject(env.DB, key, session.accountId);
  log(204, { bytes: bytes.length, access: access.kind }); // W8d: audit the write — id + size, never the bytes
  return new Response(null, { status: 204 });
}

// W13h — DELETE /api/raw/{id}/{file}: expunge one raw original from R2 (session-gated +
// per-record authorised, same as GET). The web delete flow (W15) calls this after the browser runs the pure
// removeSource() and PUTs the re-encrypted vault; idempotent (R2 delete of a missing key
// succeeds), so a retry is safe. Path/guard logic mirrors onRequestGet.
export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { request, env, params } = context;
  const start = Date.now();
  const segs = params.path ?? [];
  const id = segs[0];
  const file = segs.slice(1).join("/");
  const log = (status: number, extra: { errorCode?: string; access?: RawAccess["kind"] } = {}) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, id, ...extra });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, { errorCode: "unauthorized" });
    return session;
  }
  if (!id || !file || segs.some((s) => s === "" || s === "." || s === "..")) {
    log(400, { errorCode: "bad_path" });
    return json(400, { error: "expected /api/raw/{id}/{file}" });
  }

  // W75 — DELETE requires a real claim, not merely "not denied". The permissive-unclaimed rule is an
  // argument about reads and about a first write that claims the namespace; a delete is neither. On
  // prod, which had no ownership backfill when this shipped, every namespace was unclaimed as soon as
  // objects appeared — so any signed-up account could destroy any patient's originals, permanently.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (!mayDestroy(access)) {
    log(404, { errorCode: access.kind === "unclaimed" ? "unclaimed" : "not_owner" });
    return json(404, { error: "not found" });
  }

  const key = storeKey(env, "raw", normalizeClientId(id), file);
  await env.VAULT.delete(key);
  // W73 — the ownership row went with it. Leaving it orphaned made the namespace un-reclaimable and
  // left erasure counting a key that no longer exists.
  await env.DB.prepare("DELETE FROM raw_objects WHERE r2_key = ?").bind(key).run();
  log(200, { access: access.kind });
  return json(200, { deleted: true });
}

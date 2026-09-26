import type { D1Database } from "../../_lib/identity-types";
import { recordRawObject, listRawPdfsUnder, listRawObjectsUnder } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { normalizeClientId } from "../../../src/lib/client-id";
import { storeKey } from "../../_lib/store";
import { rawAccessFor, mayRead, mayWrite, mayDestroy, type RawAccess } from "../../_lib/raw-owner";
import { json } from "../../_lib/http";
import type { ObjectBucket } from "../../_lib/object-bucket";
import { MAX_PAGE_COUNT, isPageCount, isPdfFile } from "../../_lib/raw-files";
import { isSealed } from "../../../src/lib/raw-cipher";

// W13d — GET /api/raw/{id}/{file}: stream an original raw source (PDF/XLSX) from R2.
//
// Raw originals are AES-GCM ciphertext under a per-file content key minted in the browser and kept
// in the encrypted vault, so the deployment holds no standing key that opens them (VAULT.md). This
// route still never decrypts: it hands back whatever is stored and the browser opens it, which is
// why the content-type below describes the DOCUMENT rather than the envelope — a caller that can
// read the bytes is a caller that holds the key.
//
// Encryption is not authorisation, so the gate is unchanged: requireSession establishes who is
// asking and rawAccessFor decides whether they may have THIS id (W73).

interface Env {
  VAULT: Pick<ObjectBucket, "get" | "put" | "delete" | "list">;
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

const refusal = (access: RawAccess): string => (access.kind === "denied" ? "not_owner" : access.kind);

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
  // Two shapes have no file segment: `?unmeasured=1` asks which PDFs here have no page count yet, and
  // `?files=1` asks for the whole namespace. Both answer with KEYS ONLY (see below).
  const query = new URL(request.url).searchParams;
  const unmeasured = query.get("unmeasured") === "1";
  const listing = query.get("files") === "1";
  if (!id || segs.some((s) => s === "" || s === "." || s === "..") || (!file && !unmeasured && !listing)) {
    log(400, { errorCode: "bad_path" });
    return json(400, { error: "expected /api/raw/{id}/{file}" });
  }

  // R2 raw keys are lowercase; a vault client key predating G1 may not be.
  // W73 (SECURITY.md gap 1) — authenticated is not authorised. Until now `session.accountId` was read
  // and never compared to anything, so any signed-up account could fetch another patient's plaintext
  // PDFs. 404 rather than 403 for a namespace that is not yours: a 403 would confirm the object exists.
  // An ORPHANED namespace is refused too (W76): owned by nobody is not the same as readable by anybody.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (!mayRead(access)) {
    log(404, { errorCode: refusal(access), access: access.kind });
    return json(404, { error: "not found" });
  }

  // W77 — the corpus refuses to assemble while any PDF is unmeasured, which would strand every
  // object uploaded before page counts existed. Rather than guess a count from byte size (a 12 MB
  // scan can be 2 pages), the browser re-opens each named PDF with pdf.js and PUTs `?pages=`. This
  // returns KEYS only — no bytes, no PHI beyond the filenames the caller already owns.
  if (unmeasured || listing) {
    const prefix = storeKey(env, "raw", normalizeClientId(id), "");
    // `?files=1` is what the browser's sealing sweep diffs against its key ring, so it must be the
    // set the corpus reads — every recorded object, not only the ones the record still references.
    const keys = listing
      ? await listRawObjectsUnder(env.DB, prefix)
      : (await listRawPdfsUnder(env.DB, prefix)).filter((r) => r.pages === null).map((r) => r.r2_key);
    log(200, { access: access.kind });
    return json(200, { files: keys.map((k) => k.slice(prefix.length)) });
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
// reconciler (W15/2b), the git plaintext survival copy. Path/guard logic mirrors onRequestGet;
// idempotent (a re-PUT of the same content-addressed file is a harmless overwrite).
//
// BOTH FORMATS ARE ACCEPTED while the store migrates, and a plaintext body is logged as such so the
// sweep's remaining work is visible without listing the bucket. Rejecting plaintext is the flip, a
// later PR, and it may not land until a sweep reports zero plaintext on both stores.
const MAX_RAW_BYTES = 24 * 1024 * 1024;

/** `?pages=N` from the browser's pdf.js. Returns undefined when absent, null when present but unusable. */
function parsePages(url: string, file: string): number | undefined | null {
  const raw = new URL(url).searchParams.get("pages");
  if (raw === null) return undefined;
  if (!isPdfFile(file)) return null;
  const n = Number(raw);
  return isPageCount(n) ? n : null;
}
export async function onRequestPut(context: Ctx): Promise<Response> {
  const { request, env, params } = context;
  const start = Date.now();
  const segs = params.path ?? [];
  const id = segs[0];
  const file = segs.slice(1).join("/");
  const log = (status: number, extra: { errorCode?: string; bytes?: number; access?: RawAccess["kind"]; sealed?: boolean } = {}) =>
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

  // An EMPTY namespace is allowed through: that is how a new client's first upload works, and
  // recordRawObject below makes this caller its owner. An orphaned one is not (W76) — its first writer
  // would become owner of objects that are not theirs — and a claimed one must be theirs.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (!mayWrite(access)) {
    log(404, { errorCode: refusal(access), access: access.kind });
    return json(404, { error: "not found" });
  }

  const pages = parsePages(request.url, file);
  if (pages === null) {
    log(400, { errorCode: "bad_pages" });
    return json(400, { error: `pages must be an integer 1-${MAX_PAGE_COUNT} on a .pdf upload` });
  }

  const key = storeKey(env, "raw", normalizeClientId(id), file);
  await env.VAULT.put(key, bytes);
  // W72 — record who wrote it. The key carries a client DISPLAY NAME, which lives only inside the
  // encrypted vault, so without this row the server can never afterwards say whose object this is —
  // which is why erasure could not promise to delete a patient's originals. Written after the put, so
  // a failed upload leaves no ownership claim; INSERT OR IGNORE, so a re-PUT does not reassign it.
  // W77 — `pages` rides along because pdf.js does not run on Workers, so this request is the only
  // moment the page count is known server-side without a second round trip for the bytes.
  await recordRawObject(env.DB, key, session.accountId, { ...(pages !== undefined && { pages }), bytes: bytes.length });
  // W8d: audit the write — id + size, never the bytes. `sealed` is how the migration's remaining
  // work is read off the logs rather than by listing a bucket full of patient files.
  log(204, { bytes: bytes.length, access: access.kind, sealed: isSealed(bytes) });
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

  // W75 — DELETE requires a real claim. On prod, which had no ownership backfill when this shipped,
  // every namespace was unclaimed as soon as objects appeared — so "not denied" let any signed-up
  // account destroy any patient's originals, permanently.
  const access = await rawAccessFor(env.DB, env, session.accountId, id);
  if (!mayDestroy(access)) {
    log(404, { errorCode: refusal(access), access: access.kind });
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

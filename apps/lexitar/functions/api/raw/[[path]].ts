import type { D1Database } from "../../_lib/identity-types";
import { recordRawObject, listRawPdfsUnder, listRawObjectsUnder } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { normalizeClientId } from "../../../src/lib/client-id";
import { storeKey } from "../../_lib/store";
import { rawAccessFor, mayRead, mayWrite, mayDestroy, recordSubject, type RawAccess } from "../../_lib/raw-owner";
import { auditPrivilegedRead, sha8Of, AUDIT_UNAVAILABLE } from "../../_lib/phi-audit";
import { json } from "../../_lib/http";
import type { ObjectBucket } from "../../_lib/object-bucket";
import { MAX_PAGE_COUNT, isPageCount, isPdfFile } from "../../_lib/raw-files";
import { envelopeVersion, isSealed } from "../../../src/lib/raw-cipher";

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

// The thumbnail's key and the original's, each spelled out with a LITERAL class rather than selected
// inside one `storeKey` call. Three suites derive "which R2 key classes exist" by walking the
// `storeKey(env, "<literal>", …)` call sites under `functions/`
// (erasure-completeness.test.ts, store-key-classes.test.ts), which is what makes a new class fail CI
// at the commit that adds it instead of five nights later. A ternary in the second argument is
// invisible to every one of those sweeps, so a route could introduce a class no erasure and no
// backup had ever heard of, and nothing would say so.
const objectKey = (env: Env, thumb: boolean, id: string, file: string): string =>
  thumb
    ? storeKey(env, "thumb", normalizeClientId(id), file)
    : storeKey(env, "raw", normalizeClientId(id), file);

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
  // A flag on this handler rather than a route of its own: every gate a thumbnail read owes is
  // already above — the session, the namespace ownership, the 404-not-403 refusal and the per-object
  // audit — and a second route would be a second copy of them, which is the arrangement where one
  // copy is eventually fixed and the other is not.
  const thumb = query.get("thumb") === "1";
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
  // An `owner` access carries no vault and no subject because it needs none — the caller IS the subject,
  // so there is nothing to disclose. Only the `granted` shape names someone else.
  const auditRead = (action: "raw_object_read" | "raw_namespace_listed", meta: Record<string, unknown>) =>
    access.kind === "granted"
      ? auditPrivilegedRead(env.DB, {
          actor: session.accountId,
          subject: access.subjectAccountId,
          vaultId: access.vaultId,
          action,
          consentRef: access.consentRef,
          meta,
        })
      : Promise.resolve(null);

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
    // The keys ARE filenames, so a listing is a disclosure of which documents exist. `meta` records how
    // many, never which.
    const refused = await auditRead("raw_namespace_listed", { count: keys.length });
    if (refused) {
      log(503, { errorCode: AUDIT_UNAVAILABLE, access: access.kind });
      return refused;
    }
    log(200, { access: access.kind });
    return json(200, { files: keys.map((k) => k.slice(prefix.length)) });
  }

  // The thumbnail is a different OBJECT and the same disclosure: a chip-sized picture of a document
  // still says the document exists and still shows what it is, so everything above applies to it
  // unchanged and only the key moves. A missing thumbnail is a plain 404, which is not an error
  // condition but the signal the chip falls back on — it then paints from the original and seals one.
  const obj = await env.VAULT.get(objectKey(env, thumb, id, file));
  if (!obj) {
    log(404, { errorCode: "not_found", access: access.kind });
    return json(404, { error: thumb ? "raw thumbnail not found" : "raw source not found" });
  }

  // Per object, never coalesced: "which documents were disclosed" is the question this log exists to
  // answer, and one row per request could not answer it.
  const refused = await auditRead("raw_object_read", { sha8: sha8Of(file) });
  if (refused) {
    log(503, { errorCode: AUDIT_UNAVAILABLE, access: access.kind });
    return refused;
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
// PLAINTEXT IS REFUSED (DPG 9A.5). Every live browser has minted a per-file content key since the
// sealing landed, so the only caller a refusal can reach is a stale cached bundle, which reloads and
// retries sealed. Note what this does NOT depend on: refusing to WRITE plaintext is independent of
// whether any is still STORED. Objects written before the sealing are a GET/heal concern
// (src/lib/raw-seal-heal.ts, the owner's own browser) and an operator sweep concern
// (scripts/raw-encrypt-backfill.ts) — neither of them comes through this handler, so the refusal did
// not have to wait for either to finish.
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
  const log = (status: number, extra: { errorCode?: string; bytes?: number; access?: RawAccess["kind"]; envelope?: number | null } = {}) =>
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

  // Refused unconditionally, with no lane carved out for an unclaimed namespace: `mayWrite` admits
  // `unclaimed` because that is every patient's FIRST upload (raw-owner.ts), so scoping the refusal
  // to proven owners would refuse exactly the new patients it must not.
  if (!isSealed(bytes)) {
    log(415, { errorCode: "plaintext_refused", bytes: bytes.length, access: access.kind, envelope: envelopeVersion(bytes) });
    return json(415, { error: "raw sources must be sealed before upload", errorCode: "plaintext_refused" });
  }

  // AFTER the refusal above and not beside it, which is the whole reason the thumbnail arm is here
  // rather than in a route of its own: it inherits the plaintext chokepoint instead of restating it,
  // and the needle raw-seal-chokepoint.test.ts pins on this file does not move.
  //
  // Owner only, where an upload admits more. `mayWrite` lets `granted` and `unclaimed` through
  // (raw-owner.ts:128) because those are a clinician's legitimate upload and a patient's first one —
  // but a thumbnail is not offered content, it is a derivative somebody MINTED from a read, and a
  // clinician reading under a consent grant must not write into a patient's namespace at all. Such a
  // caller simply keeps falling back to the original, which is slow and correct.
  const thumb = new URL(request.url).searchParams.get("thumb") === "1";
  if (thumb && access.kind !== "owner") {
    log(403, { errorCode: "thumb_owner_only", access: access.kind });
    return json(403, { error: "only the owner may write a thumbnail", errorCode: "thumb_owner_only" });
  }

  const pages = parsePages(request.url, file);
  if (pages === null) {
    log(400, { errorCode: "bad_pages" });
    return json(400, { error: `pages must be an integer 1-${MAX_PAGE_COUNT} on a .pdf upload` });
  }

  const key = objectKey(env, thumb, id, file);
  await env.VAULT.put(key, bytes);
  // W72 — record WHOSE RECORD it is, which on a granted write is the subject and not the caller
  // (recordSubject, raw-owner.ts). The key carries a client DISPLAY NAME, which lives only inside the
  // encrypted vault, so without this row the server can never afterwards say whose object this is —
  // which is why erasure could not promise to delete a patient's originals. Written after the put, so
  // a failed upload leaves no ownership claim; INSERT OR IGNORE, so a re-PUT does not reassign it.
  // W77 — `pages` rides along because pdf.js does not run on Workers, so this request is the only
  // moment the page count is known server-side without a second round trip for the bytes.
  await recordRawObject(env.DB, key, recordSubject(access, session.accountId), { ...(pages !== undefined && { pages }), bytes: bytes.length });
  // W8d: audit the write — id + size, never the bytes. `envelope` is the version byte READ BACK out
  // of the body that is about to land, and it replaced a `sealed: true` that the refusal above made
  // a tautology: on this line the only value a boolean could take was the one the code had already
  // decided. A number measured from the bytes can disagree with the code, which is the whole reason
  // an audit record exists; on the 415 above it also says WHICH way the refusal went, `null` for a
  // body that is no envelope and `2` for a vault blob offered as an original.
  log(204, { bytes: bytes.length, access: access.kind, envelope: envelopeVersion(bytes) });
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

  // The thumbnail goes unconditionally and with no flag to ask for it, which is the opposite of the
  // GET and the PUT on purpose: a caller deleting an attachment is deleting the picture, and leaving
  // a legible copy of it behind because nobody passed `?thumb=1` is the failure this whole phase's
  // seven declarations exist to make impossible. R2 and the row are both idempotent on a key that
  // was never written, so an attachment that has no thumbnail costs one no-op delete.
  const keys = [
    storeKey(env, "raw", normalizeClientId(id), file),
    storeKey(env, "thumb", normalizeClientId(id), file),
  ];
  for (const key of keys) {
    await env.VAULT.delete(key);
    // W73 — the ownership row went with it. Leaving it orphaned made the namespace un-reclaimable and
    // left erasure counting a key that no longer exists.
    await env.DB.prepare("DELETE FROM raw_objects WHERE r2_key = ?").bind(key).run();
  }
  log(200, { access: access.kind });
  return json(200, { deleted: true });
}

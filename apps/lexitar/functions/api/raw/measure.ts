import type { D1Database } from "../../_lib/identity-types";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { normalizeClientId } from "../../../src/lib/client-id";
import { storeKey } from "../../_lib/store";
import { rawAccessFor, mayRead, type RawAccess } from "../../_lib/raw-owner";
import { listRawPdfsUnder, fillRawPageCount } from "../../_lib/identity-audit";
import { json } from "../../_lib/http";
import type { ObjectBucket } from "../../_lib/object-bucket";
import { MAX_PAGE_COUNT, isPageCount, isPdfFile, isRawFileSegment } from "../../_lib/raw-files";

// W77 — POST /api/raw/measure: record page counts for PDFs stored before counts were kept.
//
// The report corpus refuses to assemble while any PDF in the namespace is unmeasured (a guessed
// count would silently send an over-limit request), which would otherwise strand every object
// already in R2. `GET /api/raw/{id}?unmeasured=1` names them; the browser opens each with pdf.js —
// the only place a page can be counted, since pdf.js does not run on Workers — and posts the
// counts here. A count-only write, not a re-PUT: the bytes are up to 24 MB each and already in R2,
// so re-uploading a patient's whole history to record an integer is not a backfill.
//
// A count can be filled but never changed (fillRawPageCount's `pages IS NULL` guard), so this route
// cannot be used to talk a namespace under the corpus ceiling one request at a time. It writes no
// ownership rows either: a key with no row is not in `unmeasured` and is skipped.

interface Env {
  // `list` only: rawAccessFor needs it to tell an EMPTY namespace from an orphaned one. No bytes are
  // read here — a page count is a number the caller reports, not one this route can verify.
  VAULT: Pick<ObjectBucket, "list">;
  SESSION_SECRET: string;
  DB: D1Database;
  STORE_PREFIX: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/raw/measure";
const MAX_COUNTS = 200;

interface Count {
  file: string;
  pages: number;
}

function parseBody(body: unknown): { clientId: string; counts: Count[] } | null {
  const b = body as { clientId?: unknown; counts?: unknown };
  if (!isRawFileSegment(b?.clientId) || !Array.isArray(b.counts)) return null;
  if (b.counts.length === 0 || b.counts.length > MAX_COUNTS) return null;
  const counts = b.counts as Count[];
  const valid = counts.every((c) => isRawFileSegment(c?.file) && isPdfFile(c.file) && isPageCount(c?.pages));
  return valid ? { clientId: b.clientId, counts } : null;
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  let id: string | undefined;
  const log = (status: number, extra: { errorCode?: string; access?: RawAccess["kind"] } = {}) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, id, ...extra });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, { errorCode: "unauthorized" });
    return session;
  }

  const parsed = parseBody(await request.json().catch(() => null));
  if (!parsed) {
    log(400, { errorCode: "bad_request" });
    return json(400, {
      error: `expected { clientId, counts: [{ file, pages }] } with 1–${MAX_COUNTS} .pdf counts of 1–${MAX_PAGE_COUNT} pages`,
    });
  }
  const slug = normalizeClientId(parsed.clientId);
  id = slug;

  // Read access is the right gate: measuring needs the bytes, and anyone who may fetch them may
  // already count the pages for themselves. 404 for anything else, matching every other raw route.
  const access = await rawAccessFor(env.DB, env, session.accountId, slug);
  if (!mayRead(access)) {
    log(404, { errorCode: access.kind === "denied" ? "not_owner" : access.kind, access: access.kind });
    return json(404, { error: "not found" });
  }

  const prefix = storeKey(env, "raw", slug, "");
  const rows = await listRawPdfsUnder(env.DB, prefix);
  const unmeasured = new Set(rows.filter((r) => r.pages === null).map((r) => r.r2_key));

  let measured = 0;
  for (const c of parsed.counts) {
    const key = `${prefix}${c.file}`;
    if (!unmeasured.has(key)) continue;
    await fillRawPageCount(env.DB, key, c.pages);
    measured += 1;
  }

  log(200, { access: access.kind });
  return json(200, { measured, remaining: unmeasured.size - measured });
}

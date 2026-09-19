import type { D1Database } from "../../_lib/identity-types";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { normalizeClientId } from "../../../src/lib/client-id";
import { storeKey } from "../../_lib/store";
import { rawAccessFor, mayRead, claimNamespace, type RawAccess } from "../../_lib/raw-owner";
import type { ObjectBucket } from "../../_lib/object-bucket";
import { json } from "../../_lib/http";

// W76 — POST /api/raw/claim: take ownership of an ORPHANED client namespace by proving possession.
//
// An orphan is a namespace holding objects with no `raw_objects` row — written before ownership
// recording began, by a patient the org-key backfill cannot attribute because they revoked org
// recovery. The routes refuse orphans outright, so their owner needs a way back that a stranger does
// not have. The proof is a stored original's FULL SHA-256: the patient's decrypted vault records it
// (SourceRecord / PendingUpload), and nobody else can produce it without already holding the file.
// One matching proof claims the whole namespace — ownership resolves by namespace, not per key.
//
// Anything but an orphan answers 404 like every other refusal here, so the route is not an oracle for
// which client names exist. An owner or grantee gets 204 without effect, so the client may call it
// whenever a read 404s.

interface Env {
  VAULT: Pick<ObjectBucket, "get" | "list">;
  SESSION_SECRET: string;
  DB: D1Database;
  STORE_PREFIX: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/raw/claim";
const MAX_PROOFS = 5;
const SHA256 = /^[0-9a-f]{64}$/;
const segment = (s: unknown): s is string => typeof s === "string" && /^[^/]+$/.test(s) && s !== "." && s !== "..";

interface Proof {
  file: string;
  sha256: string;
}

function parseBody(body: unknown): { clientId: string; proofs: Proof[] } | null {
  const b = body as { clientId?: unknown; proofs?: unknown };
  if (!segment(b?.clientId) || !Array.isArray(b.proofs)) return null;
  if (b.proofs.length === 0 || b.proofs.length > MAX_PROOFS) return null;
  const proofs = b.proofs as Proof[];
  const valid = proofs.every(
    (p) => segment(p?.file) && typeof p.sha256 === "string" && SHA256.test(p.sha256),
  );
  return valid ? { clientId: b.clientId, proofs } : null;
}

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

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
    return json(400, { error: `expected { clientId, proofs: [{ file, sha256 }] } with 1–${MAX_PROOFS} proofs` });
  }
  const slug = normalizeClientId(parsed.clientId);
  id = slug;

  const access = await rawAccessFor(env.DB, env, session.accountId, slug);
  if (mayRead(access)) {
    log(204, { access: access.kind });
    return new Response(null, { status: 204 });
  }
  if (access.kind !== "orphaned") {
    log(404, { errorCode: access.kind === "denied" ? "not_owner" : access.kind, access: access.kind });
    return json(404, { error: "not found" });
  }

  for (const proof of parsed.proofs) {
    const obj = await env.VAULT.get(storeKey(env, "raw", slug, proof.file));
    if (!obj) continue;
    if (hex(await crypto.subtle.digest("SHA-256", await obj.arrayBuffer())) !== proof.sha256) continue;
    const keys = await claimNamespace(env.DB, env, slug, session.accountId);
    log(200, { access: access.kind });
    return json(200, { claimed: keys.length });
  }

  log(404, { errorCode: "claim_failed", access: access.kind });
  return json(404, { error: "not found" });
}

import { requireBearer } from "../../_lib/guard";
import { logRequest } from "../../_lib/log";
import { storeKey } from "../../_lib/store";
import { requireSession } from "../../_lib/session";
import type { D1Database } from "../../_lib/identity-types";
import { getEnvelope, getVaultByR2Key, getVaultByStagingR2Key } from "../../_lib/identity-vault";
import type { BlobConditional } from "@tinytars/vault/blob-store";
import { R2BlobStore, type R2Bucket } from "@tinytars/vault/adapters/r2";

interface Env {
  VAULT: R2Bucket;
  VAULT_TOKEN: string;
  STORE_PREFIX: string;
  ASSETS: { fetch(req: Request): Promise<Response> };
  DB: D1Database;
  SESSION_SECRET: string;
}

interface Ctx {
  request: Request;
  env: Env;
  params: { id: string };
}

const ROUTE = "/api/vault";
const MIN_BYTES = 32; // MAGIC(3) + VERSION(1) + SALT(16) + IV(12) — mirrors decryptVault
const MAX_BYTES = 5 * 1024 * 1024; // pablo is ~405 KB; generous ceiling
const HD1 = [0x48, 0x44, 0x31]; // "HD1" — the in-browser crypto magic prefix

// The static-asset filename (unprefixed — Vite copies records/public to the dist root,
// and static is already branch-isolated). The R2 key adds the per-deploy store prefix.
const assetName = (id: string) => `data-${id}.enc`;
const r2Key = (env: Env, id: string) => storeKey(env, assetName(id));

/** An `If-Match` header value is quoted (`"abc"`); BlobStore's ifMatch wants the bare token. */
const unquote = (v: string): string => v.trim().replace(/^W\//, "").replace(/^"|"$/g, "");

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// PUT — store an already-encrypted HD1 blob. Guarded; never decrypts.
export async function onRequestPut(context: Ctx): Promise<Response> {
  const { request, env, params } = context;
  const start = Date.now();
  const id = params.id;
  const log = (status: number, extra: { errorCode?: string; bytes?: number } = {}) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, id, ...extra });
  const blobStore = new R2BlobStore(env.VAULT);

  // Auth: the ops bearer (VAULT_TOKEN, server-side only) OR a logged-in principal who holds an
  // envelope for this vault. Under v2 the client no longer has a passphrase-derived bearer, so the
  // browser save path authenticates by the hd_session cookie; the envelope check scopes writes to
  // the vault's owner/granted providers.
  const denied = requireBearer(request, env.VAULT_TOKEN);
  if (denied) {
    const session = await requireSession(request, env);
    if (session instanceof Response) {
      log(401, { errorCode: "unauthorized" });
      return session;
    }
    // W75 — a re-key writes to an object no vault row points at yet, so the reservation recorded by
    // `POST /api/vault/rotate {phase:"stage"}` is the second way to be authorised here. Access is
    // still decided by holding an envelope on the vault that reserved it, not by knowing the key.
    const vault =
      (await getVaultByR2Key(env.DB, assetName(id))) ?? (await getVaultByStagingR2Key(env.DB, assetName(id)));
    if (!vault) {
      log(404, { errorCode: "not_found" });
      return json(404, { error: "vault not found" });
    }
    if (!(await getEnvelope(env.DB, vault.vaultId, session.accountId))) {
      log(403, { errorCode: "forbidden" });
      return json(403, { error: "no access to this vault" });
    }
  }

  const blob = new Uint8Array(await request.arrayBuffer());
  if (blob.length > MAX_BYTES) {
    log(413, { errorCode: "too_large" });
    return json(413, { error: "vault blob too large" });
  }
  if (blob.length < MIN_BYTES || blob[0] !== HD1[0] || blob[1] !== HD1[1] || blob[2] !== HD1[2]) {
    log(400, { errorCode: "not_hd1" });
    return json(400, { error: "not an HD1 blob" });
  }

  // W70 — optimistic concurrency. Until now this was a bare put(), so two tabs (or a patient and a
  // clinician, which the envelope model at :70-73 explicitly permits) each held the vault they loaded
  // at unlock and overwrote each other. Because a write carries the WHOLE vault, the loser did not
  // lose one field — it lost every edit since unlock, while being shown a "✓ saved" flash.
  //
  // The browser must now state which version it is replacing. `denied` is truthy only when the ops
  // bearer did NOT authenticate, i.e. we are on the session (browser) path — where the precondition is
  // REQUIRED. An optional guard is a guard that silently does not apply, and silence is the bug.
  const isSessionPath = !!denied;
  const ifMatch = request.headers.get("If-Match");
  const ifNoneMatch = request.headers.get("If-None-Match");
  let conditional: BlobConditional | undefined;
  if (ifMatch && ifMatch !== "*") {
    conditional = { ifMatch: unquote(ifMatch) };
  } else if (ifNoneMatch === "*") {
    // Create-only: the browser has never read this blob, so it must not clobber one that exists.
    conditional = { ifNoneMatch: "*" };
  } else if (isSessionPath) {
    log(428, { errorCode: "no_precondition" });
    return json(428, { error: "If-Match or If-None-Match required" });
  }

  const written = await blobStore.put(r2Key(env, id), blob, conditional);

  if (!written) {
    // The blob moved under us. Hand back the CURRENT etag so the client resolves in one round trip
    // rather than two, and record the conflict — the RATE is what says whether this is a rare edge or
    // a daily event for a patient whose clinician is also in the record.
    const current = await blobStore.get(r2Key(env, id));
    log(412, { errorCode: "conflict" });
    return new Response(JSON.stringify({ error: "vault changed since you loaded it" }), {
      status: 412,
      headers: { "content-type": "application/json", ...(current ? { etag: current.etag } : {}) },
    });
  }

  log(204, { bytes: blob.length }); // W8d: audit the write — id + size, never the bytes
  return new Response(null, { status: 204, headers: { etag: written.etag } });
}

// GET — return the already-encrypted blob. §G: gated like PUT — the ops bearer (VAULT_TOKEN) OR a
// logged-in principal who holds an envelope for this vault. The blob is ciphertext either way, but an
// authenticated read is the right posture now that identity exists (drops reliance on the manual
// Access allowlist as the only perimeter). On miss, self-seed R2 from the static asset.
export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env, params } = context;
  const start = Date.now();
  const id = params.id;
  const log = (status: number, extra: { errorCode?: string } = {}) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, id, ...extra });
  const blobHeaders = { "content-type": "application/octet-stream", "cache-control": "no-store" };
  const blobStore = new R2BlobStore(env.VAULT);

  const denied = requireBearer(request, env.VAULT_TOKEN);
  if (denied) {
    const session = await requireSession(request, env);
    if (session instanceof Response) {
      log(401, { errorCode: "unauthorized" });
      return session;
    }
    const vault = await getVaultByR2Key(env.DB, assetName(id));
    if (!vault) {
      log(404, { errorCode: "not_found" });
      return json(404, { error: "vault not found" });
    }
    if (!(await getEnvelope(env.DB, vault.vaultId, session.accountId))) {
      log(403, { errorCode: "forbidden" });
      return json(403, { error: "no access to this vault" });
    }
  }

  const obj = await blobStore.get(r2Key(env, id));
  if (obj) {
    log(200);
    // W70 — the version token the browser sends back as If-Match on its next save.
    return new Response(obj.body, { status: 200, headers: { ...blobHeaders, etag: obj.etag } });
  }

  // One-time seed: serve the committed static slice and lazily copy it into R2.
  // Pages serves the SPA index.html (200) for unknown asset paths, so an unknown id
  // would otherwise return HTML as a "blob" and seed R2 with it — guard on the HD1
  // magic so only a real encrypted slice is served/seeded; anything else is 404.
  const asset = await env.ASSETS.fetch(new Request(new URL(`/${assetName(id)}`, request.url)));
  if (asset.ok) {
    const bytes = new Uint8Array(await asset.arrayBuffer());
    if (bytes.length >= 3 && bytes[0] === HD1[0] && bytes[1] === HD1[1] && bytes[2] === HD1[2]) {
      // W70 — the etag must come from the SEEDING WRITE, not from `bytes`, which is a plain array with
      // no version. Return it without one and the very first save after a seed has no If-Match to
      // send, which under the required-precondition rule is a 428: a patient locked out of saving
      // their own record on first use. This branch is the easiest one to miss and the worst to get
      // wrong, which is why it is called out here.
      const seeded = await blobStore.put(r2Key(env, id), bytes);
      log(200);
      return new Response(bytes, { status: 200, headers: { ...blobHeaders, ...(seeded ? { etag: seeded.etag } : {}) } });
    }
  }

  log(404, { errorCode: "not_found" });
  return json(404, { error: "vault not found" });
}

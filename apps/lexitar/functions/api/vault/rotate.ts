import type { D1Database } from "../../_lib/identity-types";
import { commitRotation, getVault, setRotationStaging } from "../../_lib/identity-vault";
import { expectedPrincipalIds } from "../../_lib/vault-principals";
import { requireSession } from "../../_lib/session";
import { storeKey } from "../../_lib/store";
import { logRequest } from "../../_lib/log";
import { json } from "../../_lib/http";

// W44 P4c / W75 — commit a DEK rotation. TWO PHASES, because one phase cannot be made safe.
//
// The old contract was: the browser re-encrypts the vault under a fresh DEK, PUTs it over the SAME r2
// object, then calls this route to swap the envelope set. Between those two calls the ciphertext was
// decryptable only by a key living in one tab's memory while every stored envelope still wrapped the
// old one. A dropped connection there — during a support revoke, which is exactly when this runs —
// left the owner, the org-recovery principal and every clinician holding envelopes for a key the blob
// no longer used. Unrecoverable, and silent until the next unlock failed.
//
// Now: `stage` reserves a NEW r2 key, the browser writes the re-encrypted blob there (the PUT guard
// in [id].ts honours the reservation), and `commit` swaps the envelopes and repoints the vault in one
// D1 batch. Every interruption before that batch leaves the old blob and the old envelopes agreeing.
interface R2Bucket {
  get(key: string): Promise<unknown | null>;
}
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
  VAULT: R2Bucket;
  STORE_PREFIX: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/vault/rotate";

// Throws on anything atob rejects. W71 — that throw is the whole reason this is called BEFORE the
// first write rather than inside the write loop, where it used to fire after every envelope had
// already been deleted.
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface EnvIn {
  principalAccountId: string;
  wrappedDEK: string;
  ephemeralPublicKeyJwk: unknown;
}

const assetName = (id: string) => `data-${id}.enc`;

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  let body: { phase?: unknown; vaultId?: unknown; newVaultId?: unknown; envelopes?: unknown };
  try { body = await request.json(); } catch { log(400, "bad_json"); return json(400, { error: "invalid JSON" }); }

  // W75 — the vault is named, not guessed. This used to be `listVaultsForOwner(...)[0]`: an arbitrary
  // first row, so on any account with more than one vault the rotation re-keyed whichever row D1
  // happened to return first while the browser re-encrypted a different one.
  if (typeof body.vaultId !== "string" || !body.vaultId) { log(400, "vault_id_required"); return json(400, { error: "vaultId required" }); }
  const vault = await getVault(env.DB, body.vaultId);
  if (!vault || vault.ownerAccountId !== session.accountId) { log(404, "no_vault"); return json(404, { error: "no vault" }); }

  if (body.phase === "stage") {
    // The server mints the key, so nothing the browser sends can steer a write at another vault's
    // object. Re-staging simply supersedes an abandoned attempt; the orphaned blob is unreferenced
    // ciphertext under a key nobody holds.
    const newVaultId = crypto.randomUUID();
    await setRotationStaging(env.DB, vault.vaultId, assetName(newVaultId));
    log(200);
    return json(200, { newVaultId });
  }

  if (body.phase !== "commit") { log(400, "bad_phase"); return json(400, { error: "phase must be 'stage' or 'commit'" }); }

  if (typeof body.newVaultId !== "string" || !body.newVaultId) { log(400, "new_vault_id_required"); return json(400, { error: "newVaultId required" }); }
  const newR2Key = assetName(body.newVaultId);
  if (vault.rotationStagingR2Key !== newR2Key) { log(409, "not_staged"); return json(409, { error: "no staged rotation for this key" }); }

  const envelopes = body.envelopes as EnvIn[] | undefined;
  if (!Array.isArray(envelopes) || envelopes.length === 0 || !envelopes.every((e) => typeof e?.principalAccountId === "string" && typeof e?.wrappedDEK === "string" && e?.ephemeralPublicKeyJwk)) {
    log(400, "bad_body");
    return json(400, { error: "envelopes[] required" });
  }

  // W75 — completeness, derived server-side. `envelopes.some(e => e.id === session.accountId)` only
  // ever protected the caller from locking out THEMSELVES; a set missing the org-recovery principal or
  // an active clinician was accepted and revoked them silently.
  const expected = await expectedPrincipalIds(env.DB, vault);
  const submitted = new Set(envelopes.map((e) => e.principalAccountId));
  const missing = expected.filter((id) => !submitted.has(id));
  const extra = [...submitted].filter((id) => !expected.includes(id));
  if (missing.length || extra.length) {
    log(400, missing.length ? "principals_missing" : "principals_extra");
    return json(400, { error: "envelope set must cover exactly the vault's principals", missing, extra });
  }
  if (submitted.size !== envelopes.length) { log(400, "duplicate_principal"); return json(400, { error: "duplicate principal in envelope set" }); }

  // W71 — decode EVERY envelope before anything is written. `typeof wrappedDEK === "string"` above is
  // not validation: atob throws on a string that is not base64, and this used to run inside the write
  // loop, one iteration after every existing envelope had been deleted.
  let decoded: { principalAccountId: string; wrappedDek: Uint8Array; ephemeralPublicKeyJwk: unknown }[];
  try {
    decoded = envelopes.map((e) => ({
      principalAccountId: e.principalAccountId,
      wrappedDek: base64ToBytes(e.wrappedDEK),
      ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk,
    }));
  } catch {
    log(400, "bad_wrapped_dek");
    return json(400, { error: "wrappedDEK must be base64" });
  }
  if (decoded.some((e) => e.wrappedDek.length === 0)) {
    // An empty wrap is valid base64 and unwraps to nothing — the same lockout, one layer down.
    log(400, "empty_wrapped_dek");
    return json(400, { error: "wrappedDEK must not be empty" });
  }

  // Repointing the vault at an object that was never written is the lockout this route was rewritten
  // to prevent, arrived at from the other direction.
  if (!(await env.VAULT.get(storeKey(env, newR2Key)))) { log(409, "blob_missing"); return json(409, { error: "staged vault blob not found" }); }

  await commitRotation(env.DB, vault.vaultId, newR2Key, decoded, session.accountId);

  log(200);
  return json(200, { ok: true, envelopes: envelopes.length, r2Key: newR2Key });
}

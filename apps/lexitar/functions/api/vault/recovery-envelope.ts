import type { D1Database } from "../../_lib/identity-types";
import { deleteEnvelope, getEnvelope, listVaultsForOwner, putEnvelope, setOrgRecoveryRevoked } from "../../_lib/identity-vault";
import { insertAccessEvent } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { ORG_ACCOUNT_ID } from "../../_lib/org";

// W55 P4 — mint or revoke the org-recovery envelope for the caller's own vault. Minting is what makes
// password/passkey loss recoverable without the patient; revoking is the informed opt-out — the patient
// is warned client-side that nothing else can recover the record after this.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/vault/recovery-envelope";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  let body: { wrappedDEK?: unknown; ephemeralPublicKeyJwk?: unknown };
  try { body = await request.json(); } catch { log(400, "bad_json"); return json(400, { error: "invalid JSON" }); }
  if (typeof body.wrappedDEK !== "string" || !body.ephemeralPublicKeyJwk) {
    log(400, "bad_body");
    return json(400, { error: "wrappedDEK, ephemeralPublicKeyJwk required" });
  }

  const vault = (await listVaultsForOwner(env.DB, session.accountId))[0];
  if (!vault) { log(404, "no_vault"); return json(404, { error: "no vault" }); }

  if (vault.orgRecoveryRevokedAt) { log(409, "org_recovery_revoked"); return json(409, { error: "org recovery revoked" }); }

  if (await getEnvelope(env.DB, vault.vaultId, ORG_ACCOUNT_ID)) {
    log(200);
    return json(200, { status: "exists" });
  }

  await putEnvelope(env.DB, {
    vaultId: vault.vaultId,
    principalAccountId: ORG_ACCOUNT_ID,
    wrappedDek: base64ToBytes(body.wrappedDEK),
    ephemeralPublicKeyJwk: body.ephemeralPublicKeyJwk,
    createdBy: session.accountId,
  });
  await insertAccessEvent(env.DB, {
    actorAccountId: session.accountId,
    subjectAccountId: session.accountId,
    vaultId: vault.vaultId,
    action: "org_recovery_minted",
  });

  log(201);
  return json(201, { status: "created" });
}

export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const vault = (await listVaultsForOwner(env.DB, session.accountId))[0];
  if (!vault) { log(404, "no_vault"); return json(404, { error: "no vault" }); }

  await deleteEnvelope(env.DB, vault.vaultId, ORG_ACCOUNT_ID);
  const revokedAt = vault.orgRecoveryRevokedAt ?? new Date().toISOString();
  await setOrgRecoveryRevoked(env.DB, vault.vaultId, revokedAt);
  await insertAccessEvent(env.DB, {
    actorAccountId: session.accountId,
    subjectAccountId: session.accountId,
    vaultId: vault.vaultId,
    action: "org_recovery_revoked",
  });

  log(200);
  return json(200, { status: "revoked", revokedAt });
}

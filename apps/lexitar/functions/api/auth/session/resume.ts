import type { D1Database } from "../../../_lib/identity-types";
import { getAccount } from "../../../_lib/identity-accounts";
import { getEnvelope, listVaultsForOwner } from "../../../_lib/identity-vault";
import { requireSession } from "../../../_lib/session";
import { logRequest } from "../../../_lib/log";

// W49 — plain-refresh session resume (password/passkey). The hd_session cookie survives a refresh,
// but the client dropped the in-memory account key + vault DEK. This session-gated read returns the
// vault location + the owner's DEK envelope (NOT the wrapped private key — the client already holds a
// non-extractable copy of the account private key in IndexedDB) so the client can re-derive the DEK
// and reopen the vault without re-auth. Zero-knowledge is preserved: the server never sees the key.
// (The Google path resumes via /api/auth/google/session, which is server-custody by W45 design.)
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/session/resume";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }

  const account = await getAccount(env.DB, session.accountId);
  if (!account) {
    log(404, "not_found");
    return json(404, { error: "account not found" });
  }

  const vault = (await listVaultsForOwner(env.DB, session.accountId))[0] ?? null;
  const envelope = vault ? await getEnvelope(env.DB, vault.vaultId, session.accountId) : null;

  log(200);
  return json(200, {
    accountId: account.id,
    vaultId: vault?.vaultId ?? null,
    r2Key: vault?.r2Key ?? null,
    rotationPending: vault?.rotationPending ?? false,
    providerKind: account.providerKind,
    ownerEnvelope: envelope
      ? { wrappedDEK: bytesToBase64(envelope.wrappedDek), ephemeralPublicKeyJwk: envelope.ephemeralPublicKeyJwk }
      : null,
  });
}

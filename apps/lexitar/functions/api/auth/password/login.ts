import type { D1Database } from "../../../_lib/identity-types";
import { getAccountByEmail } from "../../../_lib/identity-accounts";
import { getCredential } from "../../../_lib/identity-credentials";
import { getEnvelope, listVaultsForOwner } from "../../../_lib/identity-vault";
import { logRequest } from "../../../_lib/log";
import { signSession, sessionSetCookie } from "../../../_lib/session";
import { sha256Base64Url, timingSafeEqualStr } from "../../../_lib/verifier";

// W44 P2 — password login. Verifies the client-derived authHash against the stored
// SHA-256(authHash) and hands back the wrapped private key + owner envelope; the client
// re-derives the KEK from password+salt and unwraps locally. The server never sees the
// password, the KEK, or the DEK.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}

interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/password/login";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}




const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  try {
    const body = (await request.json()) as Partial<{ email: string; authHash: string }>;
    if (!body.email || !body.authHash) {
      log(400, "missing_fields");
      return json(400, { error: "missing required fields" });
    }

    const acct = await getAccountByEmail(env.DB, body.email);
    if (!acct) {
      log(401, "invalid_credentials");
      return json(401, { error: "invalid credentials" });
    }
    const cred = await getCredential(env.DB, acct.id, "password");
    if (!cred) {
      log(401, "invalid_credentials");
      return json(401, { error: "invalid credentials" });
    }

    const kdfParams = cred.kdfParams as { authHashSha256: string; [key: string]: unknown };
    const candidateHash = await sha256Base64Url(body.authHash);
    if (!timingSafeEqualStr(candidateHash, kdfParams.authHashSha256)) {
      log(401, "invalid_credentials");
      return json(401, { error: "invalid credentials" });
    }

    const vault = (await listVaultsForOwner(env.DB, acct.id))[0] ?? null;
    const envelope = vault ? await getEnvelope(env.DB, vault.vaultId, acct.id) : null;
    const { authHashSha256: _authHashSha256, ...publicKdfParams } = kdfParams;

    const token = await signSession(env, acct.id);
    log(200);
    return json(
      200,
      {
        accountId: acct.id,
        vaultId: vault?.vaultId ?? null,
        r2Key: vault?.r2Key ?? null,
        rotationPending: vault?.rotationPending ?? false,
        wrappedPrivateKey: bytesToBase64(cred.wrappedPrivateKey),
        kdfParams: publicKdfParams,
        ownerEnvelope: envelope
          ? { wrappedDEK: bytesToBase64(envelope.wrappedDek), ephemeralPublicKeyJwk: envelope.ephemeralPublicKeyJwk }
          : null,
      },
      { "set-cookie": sessionSetCookie(token) }
    );
  } catch {
    log(500, "login_failed");
    return json(500, { error: "login failed" });
  }
}

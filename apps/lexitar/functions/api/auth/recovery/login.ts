import type { D1Database } from "../../../_lib/identity-types";
import { getAccountByEmail, revokeSessions } from "../../../_lib/identity-accounts";
import { addIdentity, getCredential, listIdentities, putCredential } from "../../../_lib/identity-credentials";
import { getEnvelope, listVaultsForOwner } from "../../../_lib/identity-vault";
import { logRequest } from "../../../_lib/log";
import { sendMethodAddedNotice } from "../../../_lib/email";
import type { EmailEnv } from "../../../_lib/email";
import { signSession, sessionSetCookie } from "../../../_lib/session";
import { sha256Base64Url, timingSafeEqualStr } from "../../../_lib/verifier";

// W44 P8b — recover with a recovery code. Verifies the client-derived recovery authHash against the
// stored SHA-256 verifier (added at code generation) and hands back the recovery-wrapped private key +
// owner envelope; the client re-derives the KEK from code+salt and unwraps locally. Mirrors
// auth/password/login.ts — the server never sees the code, the KEK, or the DEK.
type Env = EmailEnv & {
  DB: D1Database;
  SESSION_SECRET: string;
};
interface Ctx {
  request: Request;
  env: Env;
  waitUntil?: (p: Promise<unknown>) => void;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ROUTE = "/api/auth/recovery/login";

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
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  try {
    const body = (await request.json()) as Partial<{
      email: string;
      recoveryAuthHash: string;
      // W73 — the replacement password, derived client-side exactly as signup derives it. Optional so
      // the pre-W73 shape still works, but the UI always sends it.
      newCredential: { wrappedPrivateKey: string; kdfParams: { salt: string; iterations: number }; authHash: string };
    }>;
    if (!body.email || !body.recoveryAuthHash) { log(400, "missing_fields"); return json(400, { error: "missing required fields" }); }
    const nc = body.newCredential;
    if (nc !== undefined && (typeof nc?.wrappedPrivateKey !== "string" || typeof nc?.authHash !== "string" || !nc?.kdfParams)) {
      log(400, "bad_new_credential");
      return json(400, { error: "newCredential must carry wrappedPrivateKey, kdfParams and authHash" });
    }

    const acct = await getAccountByEmail(env.DB, body.email);
    const cred = acct ? await getCredential(env.DB, acct.id, "recovery") : null;
    const kdfParams = cred?.kdfParams as { authHashSha256?: string; salt: string; iterations: number } | undefined;
    // No verifier stored (pre-P8b recovery credential) → not redeemable; treat as invalid.
    if (!acct || !cred || !kdfParams?.authHashSha256) { log(401, "invalid_recovery"); return json(401, { error: "invalid recovery code" }); }

    const candidate = await sha256Base64Url(body.recoveryAuthHash);
    if (!timingSafeEqualStr(candidate, kdfParams.authHashSha256)) { log(401, "invalid_recovery"); return json(401, { error: "invalid recovery code" }); }

    const vault = (await listVaultsForOwner(env.DB, acct.id))[0] ?? null;
    const envelope = vault ? await getEnvelope(env.DB, vault.vaultId, acct.id) : null;
    const { authHashSha256: _v, ...publicKdfParams } = kdfParams;

    // W73 — redemption REPLACES the password in the same request that proves the recovery code.
    //
    // It has to be here rather than a follow-up call: the account still has its old password
    // credential, so `stepUpForMethodChange` would demand the very password the user is recovering
    // BECAUSE they forgot it. Doing it here is also the honest atomicity — a user who redeems a code
    // and then fails to set a password would otherwise be signed in with a credential they cannot
    // reproduce, which is exactly the state they started in.
    //
    // The account private key does NOT change: it is re-wrapped under a new KEK. So the passkey,
    // Google and recovery credentials still wrap the same key and stay valid — unlike a provider-issued
    // recovery (W73 Phase D), which mints a new keypair and must therefore clear them.
    if (nc) {
      const hadPassword = await getCredential(env.DB, acct.id, "password");
      await putCredential(env.DB, {
        accountId: acct.id,
        method: "password",
        wrappedPrivateKey: base64ToBytes(nc.wrappedPrivateKey),
        kdfParams: { ...nc.kdfParams, authHashSha256: await sha256Base64Url(nc.authHash) },
      });
      if (!hadPassword && !(await listIdentities(env.DB, acct.id)).some((i) => i.method === "password")) {
        await addIdentity(env.DB, { accountId: acct.id, method: "password" });
      }
      // RECOVERY.md I5 — recovery replaces credentials and revokes sessions. Anyone holding a cookie
      // issued under the old password is signed out; the caller's own cookie is minted below, AFTER
      // this, so the person recovering stays in.
      await revokeSessions(env.DB, acct.id);
      if (acct.email) {
        const notice = sendMethodAddedNotice(env, { to: acct.email, method: "password (account recovery)" }).catch((e) =>
          console.log(`[email] recovery notice failed: ${(e as Error).message}`),
        );
        if (context.waitUntil) context.waitUntil(notice);
        else await notice;
      }
    }

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
        ownerEnvelope: envelope ? { wrappedDEK: bytesToBase64(envelope.wrappedDek), ephemeralPublicKeyJwk: envelope.ephemeralPublicKeyJwk } : null,
      },
      { "set-cookie": sessionSetCookie(token) }
    );
  } catch {
    log(500, "recover_failed");
    return json(500, { error: "recover failed" });
  }
}

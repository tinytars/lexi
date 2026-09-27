import type { D1Database } from "../../../_lib/identity-types";
import { getAccountByEmail } from "../../../_lib/identity-accounts";
import { getCredential } from "../../../_lib/identity-credentials";
import { getEnvelope, listVaultsForOwner } from "../../../_lib/identity-vault";
import { logRequest } from "../../../_lib/log";
import { signSession, sessionSetCookie } from "../../../_lib/session";
import { sha256Base64Url, timingSafeEqualStr } from "../../../_lib/verifier";
import { json } from "../../../_lib/http";
import { callerIp } from "../../../_lib/caller-ip";
import { spendAuthBudget, forgiveAuthAttempt, tooManyAttempts, TOO_MANY_ATTEMPTS, COST_LOGIN } from "../../../_lib/auth-budget";

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

    // Charged and judged BEFORE the account lookup, so the refusal cannot depend on whether the address
    // is registered — the same reason every failure below answers a uniform 401.
    const ip = callerIp(request);
    const budget = await spendAuthBudget(env.DB, env, { ip, email: body.email, cost: COST_LOGIN });
    if (!budget.allowed) {
      // Which cap fired goes to the log only. `tooManyAttempts` names none, so the 429 is no more of an
      // oracle than the 401 is.
      log(429, `${TOO_MANY_ATTEMPTS}:${budget.reason}`);
      return tooManyAttempts(budget.retryAfterSeconds);
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

    // The password was right, so this was not a guess: forget the email's window and refund the whole
    // sign-in — this login AND the salt probe that preceded it — to the address and global buckets.
    // Failures from that address stay counted; succeeding costs nothing. See the module header.
    await forgiveAuthAttempt(env.DB, env, { ip, email: body.email });

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

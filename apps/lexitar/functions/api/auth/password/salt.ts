import type { D1Database } from "../../../_lib/identity-types";
import { getAccountByEmail } from "../../../_lib/identity-accounts";
import { getCredential } from "../../../_lib/identity-credentials";
import { logRequest } from "../../../_lib/log";
import { decoySalt, KDF_ITERATIONS } from "../../../_lib/decoy-salt";
import { json } from "../../../_lib/http";
import { callerIp } from "../../../_lib/caller-ip";
import { spendAuthBudget, tooManyAttempts, TOO_MANY_ATTEMPTS, COST_SALT } from "../../../_lib/auth-budget";

// W44 P2 — the KDF salt is public (not secret); the client needs it before it can derive
// authHash for login, so it's looked up by email ahead of the login POST. Never returns
// the stored authHashSha256.
interface Env {
  DB: D1Database;
  // W71 — keys the decoy salt returned for an unknown account. See _lib/decoy-salt.ts.
  SESSION_SECRET: string;
}

interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/password/salt";

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const email = new URL(request.url).searchParams.get("email");
  if (!email) {
    log(400, "missing_email");
    return json(400, { error: "missing email" });
  }

  // Half the cost of a sign-in attempt: this is the reconnaissance half of the pair and already answers
  // with a decoy, so the cap exists to stop enumeration VOLUME rather than a single probe. It shares
  // login's buckets, so walking an address book here spends the budget for guessing against it there.
  const budget = await spendAuthBudget(env.DB, env, { ip: callerIp(request), email, cost: COST_SALT });
  if (!budget.allowed) {
    // Which cap fired goes to the log only, so the 429 gives away no more than the decoy below does.
    log(429, `${TOO_MANY_ATTEMPTS}:${budget.reason}`);
    return tooManyAttempts(budget.retryAfterSeconds);
  }

  const acct = await getAccountByEmail(env.DB, email);
  const cred = acct ? await getCredential(env.DB, acct.id, "password") : null;
  if (!cred) {
    // W71 — a decoy rather than a 404, so this endpoint stops telling an unauthenticated caller which
    // addresses are registered. The login that follows still fails, uniformly.
    log(200, "decoy");
    return json(200, { salt: await decoySalt(env.SESSION_SECRET, email, "password"), iterations: KDF_ITERATIONS });
  }

  const { salt, iterations } = cred.kdfParams as { salt: string; iterations: number };
  log(200);
  return json(200, { salt, iterations });
}

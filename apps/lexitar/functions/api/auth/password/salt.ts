import type { D1Database } from "../../../_lib/identity-types";
import { getAccountByEmail } from "../../../_lib/identity-accounts";
import { getCredential } from "../../../_lib/identity-credentials";
import { logRequest } from "../../../_lib/log";
import { decoySalt, KDF_ITERATIONS } from "../../../_lib/decoy-salt";
import { json } from "../../../_lib/http";

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

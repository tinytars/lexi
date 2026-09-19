// W73 — the live recovery grant's KDF salt, looked up by email so the browser can derive the code's
// KEK and proof before redeeming. Mirrors auth/recovery/salt.ts exactly, including the decoy.
//
// The salt is public by construction — it is stored beside the blob it salts and is useless without the
// code. What is NOT public is whether a grant exists at all: that would say whether a clinician has
// started a recovery for a given person, which is a fact about their care rather than their account. So
// an address with no live grant gets a stable decoy and the redemption that follows fails uniformly,
// the same shape W71 gave the password and recovery salt lookups.

import type { D1Database } from "../../../_lib/identity-types";
import { getAccountByEmail } from "../../../_lib/identity-accounts";
import { getLiveGrant } from "../../../_lib/recovery";
import { decoySalt, KDF_ITERATIONS } from "../../../_lib/decoy-salt";
import { logRequest } from "../../../_lib/log";
import { json } from "../../../_lib/http";

interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/recovery/grant-salt";

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const email = new URL(request.url).searchParams.get("email");
  if (!email) { log(400, "missing_email"); return json(400, { error: "missing email" }); }

  const acct = await getAccountByEmail(env.DB, email);
  const grant = acct && !acct.deletedAt ? await getLiveGrant(env.DB, acct.id) : null;
  if (!grant?.wrappedDek) {
    // A DIFFERENT decoy purpose from the recovery-credential salt, so the two lookups cannot be
    // compared against each other to learn which of the two kinds of recovery an address has.
    log(200, "decoy");
    return json(200, { salt: await decoySalt(env.SESSION_SECRET, email, "grant"), iterations: KDF_ITERATIONS });
  }

  log(200);
  return json(200, { salt: grant.kdfParams.salt, iterations: grant.kdfParams.iterations });
}

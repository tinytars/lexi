import type { D1Database } from "../../_lib/identity-types";
import { getPublicKey } from "../../_lib/identity-credentials";
import { logRequest } from "../../_lib/log";
import { ORG_ACCOUNT_ID } from "../../_lib/org";
import { json } from "../../_lib/http";

// W55 P4 — unauthenticated by design: signup has no session yet to wrap the org-recovery envelope
// against, and a public key is public regardless of who asks for it.
interface Env {
  DB: D1Database;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/vault/org-key";

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const org = await getPublicKey(env.DB, ORG_ACCOUNT_ID);
  if (!org) { log(500, "missing_org_key"); return json(500, { error: "missing org public key" }); }

  log(200);
  return json(200, { orgAccountId: ORG_ACCOUNT_ID, orgPublicKeyJwk: org.publicKeyJwk });
}

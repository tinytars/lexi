import type { D1Database } from "../../_lib/identity-types";
import { getAccountByEmail } from "../../_lib/identity-accounts";
import { getPublicKey } from "../../_lib/identity-credentials";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { json } from "../../_lib/http";

// W44 P4 — resolve a provider by email so a logged-in patient can wrap their vault DEK to that
// provider's public key (the grant step happens client-side; this only hands back the public key).
// Returns a UNIFORM 404 for an unknown OR non-provider account, so this enumerates only the
// provider directory, not the whole user base.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/providers/lookup";

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

  const email = new URL(request.url).searchParams.get("email");
  if (!email) {
    log(400, "missing_email");
    return json(400, { error: "email required" });
  }

  const acct = await getAccountByEmail(env.DB, email);
  if (!acct || !acct.providerKind) {
    log(404, "not_found");
    return json(404, { error: "provider not found" });
  }
  const pub = await getPublicKey(env.DB, acct.id);
  if (!pub) {
    log(404, "not_found");
    return json(404, { error: "provider not found" });
  }

  log(200);
  return json(200, {
    providerAccountId: acct.id,
    displayName: acct.displayName,
    providerKind: acct.providerKind,
    publicKeyJwk: pub.publicKeyJwk,
  });
}

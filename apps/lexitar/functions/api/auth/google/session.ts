import { requireSession } from "../../../_lib/session";
import { logRequest } from "../../../_lib/log";
import { loadGoogleKeyMaterial } from "../../../_lib/google";
import type { D1Database } from "../../../_lib/identity-types";
import { json } from "../../../_lib/http";

// W45 §J — bootstrap the client after a Google login redirect (/?google=1). The session cookie is
// already set; this returns the (server-unwrapped) PLAINTEXT private key + owner envelope so the
// client can recover the vault DEK. This server-assisted unwrap is the accepted departure from the
// zero-knowledge password/passkey model — the operator holds the KEK that produced this key.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
  GOOGLE_KEK: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/google/session";

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  try {
    const material = await loadGoogleKeyMaterial(env.DB, session.accountId, env.GOOGLE_KEK);
    log(200);
    return json(200, material);
  } catch {
    log(400, "no_google_credential");
    return json(400, { error: "not a google account" });
  }
}

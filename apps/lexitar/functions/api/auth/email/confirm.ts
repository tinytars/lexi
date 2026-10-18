import type { D1Database } from "../../../_lib/identity-types";
import { getAccount, setEmailConfirmed } from "../../../_lib/identity-accounts";
import type { EmailEnv } from "../../../_lib/email";
import { verifyEmailToken } from "../../../_lib/email";
import { logRequest } from "../../../_lib/log";

// W47 — email verification link target. NOT session-gated: the signed, email-bound token in the URL
// is the authorization (the link is often opened in a different browser than the one signed in). If
// the account's email changed since the link was minted, the token email no longer matches and the
// link is treated as superseded. Idempotent.
interface Env extends EmailEnv {
  DB: D1Database;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/email/confirm";

function redirect(status: string): Response {
  return new Response(null, { status: 302, headers: { location: `/?email_verify=${status}` } });
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const token = new URL(request.url).searchParams.get("token");
  const parsed = await verifyEmailToken(env, token);
  if (!parsed) { log(400, "bad_token"); return redirect("invalid"); }

  const account = await getAccount(env.DB, parsed.accountId);
  if (!account || account.email !== parsed.email) { log(409, "superseded"); return redirect("invalid"); }

  await setEmailConfirmed(env.DB, parsed.accountId, true);
  log(200);
  return redirect("ok");
}

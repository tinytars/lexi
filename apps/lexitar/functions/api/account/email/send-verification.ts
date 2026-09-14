import type { D1Database } from "../../../_lib/identity-types";
import { getAccount } from "../../../_lib/identity-accounts";
import type { EmailEnv } from "../../../_lib/email";
import { sendVerificationEmail } from "../../../_lib/email";
import { requireSession } from "../../../_lib/session";
import { logRequest } from "../../../_lib/log";

// W47 — (re)send the verification email for the caller's current email. Non-blocking flow: the app
// never gates on confirmation, so this backs the "Resend" action in the account menu/banner.
interface Env extends EmailEnv {
  DB: D1Database;
}
interface Ctx {
  request: Request;
  env: Env;
  waitUntil?: (p: Promise<unknown>) => void;
}

const ROUTE = "/api/account/email/send-verification";
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const account = await getAccount(env.DB, session.accountId);
  if (!account) { log(404, "not_found"); return json(404, { error: "account not found" }); }
  if (!account.email) { log(400, "no_email"); return json(400, { error: "account has no email" }); }
  if (account.emailConfirmed) { log(200); return json(200, { ok: true, alreadyConfirmed: true }); }

  const origin = new URL(request.url).origin;
  const p = sendVerificationEmail(env, { to: account.email, accountId: account.id, origin }).catch((e) =>
    console.log(`[email] send-verification failed: ${(e as Error).message}`),
  );
  if (context.waitUntil) context.waitUntil(p);
  else await p;

  log(200);
  return json(200, { ok: true });
}

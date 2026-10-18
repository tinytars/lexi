import { logRequest } from "../../_lib/log";
import { requireSession, sessionClearCookie, type SessionEnv } from "../../_lib/session";
import { revokeSessions } from "../../_lib/identity-accounts";

// W44 cutover — drop the hd_session cookie.
//
// W71 — clearing the cookie is no longer the whole of logout. The cookie is a self-contained 30-day
// HMAC, so a copy taken before logout (a shared machine, a synced browser profile, a proxy log) kept
// working for the rest of its TTL: the browser had forgotten the session, the server never knew about
// it. Logout now also stamps accounts.sessions_valid_from, which is what makes "log me out" mean it.
//
// Still safe to call unauthenticated — it just has nothing to revoke, and clears the cookie anyway.
const ROUTE = "/api/auth/logout";

export async function onRequestPost(context: { request: Request; env: SessionEnv }): Promise<Response> {
  const start = Date.now();
  const session = await requireSession(context.request, context.env);
  if (!(session instanceof Response)) await revokeSessions(context.env.DB, session.accountId);

  logRequest({ route: ROUTE, status: 204, latencyMs: Date.now() - start });
  return new Response(null, { status: 204, headers: { "set-cookie": sessionClearCookie() } });
}

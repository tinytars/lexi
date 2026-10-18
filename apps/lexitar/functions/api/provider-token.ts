import { logRequest } from "../_lib/log";
import { json } from "../_lib/http";
import { requireSession } from "../_lib/session";
import type { D1Database } from "../_lib/identity-types";
import { getAccount } from "../_lib/identity-accounts";
import { can, roleOf } from "../_lib/capabilities";

// W15/3b, re-gated in the W44 cutover — deliver the distinct PROVIDER_TOKEN to a proven provider.
// Provider-hood is now the account's role (provider_kind != null) proven by the hd_session cookie,
// not the retired sha256(fam4) unlock token. PROVIDER_TOKEN stays a DISTINCT server secret that
// authorizes the money-spending /api/refresh-finding and rotates independently. PHI-free.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
  PROVIDER_TOKEN: string; // distinct random secret handed to a proven provider
}

const ROUTE = "/api/provider-token";

const noStore = (status: number, body: unknown): Response => json(status, body, { "cache-control": "no-store" });

export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const requestId = request.headers.get("cf-ray") ?? undefined;
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, requestId, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }
  const account = await getAccount(env.DB, session.accountId);
  // Only clinicians get the refresh-finding token — a support agent must not receive money-spending
  // authority (W44 P4b). The rule itself now lives in _lib/capabilities.ts, where it can be read
  // against every other role's row instead of only here.
  if (!can(roleOf(account), "ai:spend")) {
    log(403, "not_a_provider");
    return noStore(403, { error: "not a provider", errorCode: "not_a_provider" });
  }
  if (!env.PROVIDER_TOKEN) {
    log(500, "unconfigured");
    return noStore(500, { error: "provider token not configured", errorCode: "unconfigured" });
  }
  log(200);
  return noStore(200, { token: env.PROVIDER_TOKEN });
}

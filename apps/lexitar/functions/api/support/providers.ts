import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { listPatientsForProvider } from "../../_lib/identity-providers";
import { can, roleOf } from "../../_lib/capabilities";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { json } from "../../_lib/http";

// W50 — the support console's PROVIDER list: clinicians who approved this support agent's roster
// request (active, unexpired). Listing only; entering a provider's roster goes through the audited
// /api/support/provider-roster. A provider "link" is a support link whose target is a provider account
// (provider_kind set) — it carries no envelope, which is exactly why it's roster access, not vault access.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/support/providers";

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
  const me = await getAccount(env.DB, session.accountId);
  if (!can(roleOf(me), "support:directory")) {
    log(403, "not_support");
    return json(403, { error: "not a support agent" });
  }

  const now = Date.now();
  const links = await listPatientsForProvider(env.DB, session.accountId);
  const providers: unknown[] = [];
  for (const link of links) {
    if (link.role !== "support" || link.status !== "active") continue;
    if (link.expiresAt && new Date(link.expiresAt).getTime() < now) continue;
    const acct = await getAccount(env.DB, link.ownerAccountId);
    if (!acct || roleOf(acct) === "patient") continue; // provider targets only; patients are /support/owners
    providers.push({ linkId: link.id, providerAccountId: acct.id, displayName: acct.displayName, email: acct.email, expiresAt: link.expiresAt });
  }

  log(200);
  return json(200, { providers });
}

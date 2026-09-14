import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { listPatientsForProvider } from "../../_lib/identity-providers";
import { can, roleOf } from "../../_lib/capabilities";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";

// W50 — the support agent's OUTSTANDING (invited, not-yet-approved) access requests, so the console can
// show "requested · awaiting approval" instead of the request silently vanishing. Covers both target
// kinds: a patient (vault consent) and a provider (roster). `kind` is derived from the target account.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/support/requests";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  if (!can(roleOf(me), "support:queue")) {
    log(403, "not_support");
    return json(403, { error: "not a support agent" });
  }

  const requests: unknown[] = [];
  for (const link of await listPatientsForProvider(env.DB, session.accountId)) {
    if (link.role !== "support" || link.status !== "invited") continue;
    const acct = await getAccount(env.DB, link.ownerAccountId);
    if (!acct) continue;
    requests.push({
      linkId: link.id,
      targetAccountId: acct.id,
      displayName: acct.displayName,
      email: acct.email,
      kind: roleOf(acct) === "patient" ? "owner" : "provider",
    });
  }

  log(200);
  return json(200, { requests });
}

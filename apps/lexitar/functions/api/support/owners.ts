import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { getEnvelope, listVaultsForOwner } from "../../_lib/identity-vault";
import { listPatientsForProvider } from "../../_lib/identity-providers";
import { can, roleOf } from "../../_lib/capabilities";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";

// W44 P4b — the support console's patient list: active, unexpired support grants only. No envelope is
// returned here (listing is not access) — entering a patient goes through the audited /api/support/access.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/support/owners";

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
  if (!can(roleOf(me), "support:patients")) {
    log(403, "not_support");
    return json(403, { error: "not a support agent" });
  }

  const now = Date.now();
  const links = await listPatientsForProvider(env.DB, session.accountId);
  const patients: unknown[] = [];
  for (const link of links) {
    if (link.role !== "support" || link.status !== "active") continue;
    if (link.expiresAt && new Date(link.expiresAt).getTime() < now) continue;
    const acct = await getAccount(env.DB, link.ownerAccountId);
    if (!acct) continue;
    const vault = (await listVaultsForOwner(env.DB, link.ownerAccountId))[0];
    if (!vault || !(await getEnvelope(env.DB, vault.vaultId, session.accountId))) continue;
    patients.push({ ownerAccountId: acct.id, displayName: acct.displayName, expiresAt: link.expiresAt });
  }

  log(200);
  return json(200, { patients });
}

import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { getEnvelope, listVaultsForOwner } from "../../_lib/identity-vault";
import { listPatientsForProvider } from "../../_lib/identity-providers";
import { insertAccessEvent } from "../../_lib/identity-audit";
import { can, roleOf } from "../../_lib/capabilities";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";

// W50 — a support agent views a clinician's roster (requires an active, unexpired support→provider
// grant). Returns the clinician's patients as metadata; `openable` marks the ones the support agent can
// actually open — i.e. those where THAT patient separately granted support access (an active envelope).
// A provider approval never transitively exposes PHI: non-consented rows are visible but not openable.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/support/provider-roster";

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
  if (!can(roleOf(me), "support:directory")) {
    log(403, "not_support");
    return json(403, { error: "not a support agent" });
  }

  const providerId = new URL(request.url).searchParams.get("providerId");
  if (!providerId) {
    log(400, "bad_body");
    return json(400, { error: "providerId required" });
  }

  const now = Date.now();
  const myLinks = await listPatientsForProvider(env.DB, session.accountId);

  // The support→provider grant must be active + unexpired.
  const grant = myLinks.find(
    (l) => l.ownerAccountId === providerId && l.role === "support" && l.status === "active" && !(l.expiresAt && new Date(l.expiresAt).getTime() < now)
  );
  if (!grant) {
    log(403, "no_grant");
    return json(403, { error: "no active support access to this provider" });
  }

  // Patients this support agent can already open: an active, unexpired support link WITH an envelope.
  // And patients with an outstanding (invited) request, so the UI shows "requested" not "Request access".
  const openablePatientIds = new Set<string>();
  const pendingPatientIds = new Set<string>();
  for (const l of myLinks) {
    if (l.role !== "support") continue;
    if (l.status === "invited") { pendingPatientIds.add(l.ownerAccountId); continue; }
    if (l.status !== "active") continue;
    if (l.expiresAt && new Date(l.expiresAt).getTime() < now) continue;
    const v = (await listVaultsForOwner(env.DB, l.ownerAccountId))[0];
    if (v && (await getEnvelope(env.DB, v.vaultId, session.accountId))) openablePatientIds.add(l.ownerAccountId);
  }

  const roster: unknown[] = [];
  for (const link of await listPatientsForProvider(env.DB, providerId)) {
    if (link.role !== "primary" || link.status !== "active") continue;
    const acct = await getAccount(env.DB, link.ownerAccountId);
    if (!acct) continue;
    roster.push({
      ownerAccountId: acct.id,
      displayName: acct.displayName,
      email: acct.email,
      openable: openablePatientIds.has(acct.id),
      pending: pendingPatientIds.has(acct.id),
    });
  }

  await insertAccessEvent(env.DB, {
    actorAccountId: session.accountId,
    subjectAccountId: providerId,
    vaultId: null,
    action: "support_provider_roster_viewed",
    consentRef: grant.consentRef,
  });

  log(200);
  return json(200, { roster });
}

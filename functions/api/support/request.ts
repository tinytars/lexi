import type { D1Database } from "../../_lib/identity-types";
import { getAccount, getAccountByEmail } from "../../_lib/identity-accounts";
import { listVaultsForOwner } from "../../_lib/identity-vault";
import { createProviderLink, listPatientsForProvider } from "../../_lib/identity-providers";
import { insertAccessEvent } from "../../_lib/identity-audit";
import { can, roleOf } from "../../_lib/capabilities";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";

// W44 P4b — a support agent requests access to a patient. This creates a PENDING (invited) support
// link only — no envelope, so support has no key until the patient approves (§D consented access).
// Audited as support_access_requested.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/support/request";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function onRequestPost(context: Ctx): Promise<Response> {
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

  let body: { patientEmail?: unknown };
  try {
    body = await request.json();
  } catch {
    log(400, "bad_json");
    return json(400, { error: "invalid JSON" });
  }
  if (typeof body.patientEmail !== "string" || !body.patientEmail) {
    log(400, "bad_body");
    return json(400, { error: "patientEmail required" });
  }

  const target = await getAccountByEmail(env.DB, body.patientEmail);
  if (!target) {
    log(404, "not_found");
    return json(404, { error: "account not found" });
  }
  if (target.id === session.accountId) {
    log(400, "self_target");
    return json(400, { error: "cannot request access to yourself" });
  }
  // W50 — a provider target (clinician) means a ROSTER request: support gets that clinician's patient
  // list on approval, no vault/envelope (nothing of a provider's is encrypted). A support target has
  // no shareable roster. A patient target (provider_kind null) is the original vault-consent flow.
  if (roleOf(target) === "support") {
    log(400, "unsupported_target");
    return json(400, { error: "cannot request access to a support agent" });
  }
  const isProviderTarget = roleOf(target) === "primary";

  const existing = (await listPatientsForProvider(env.DB, session.accountId)).find(
    (l) => l.ownerAccountId === target.id && l.status !== "revoked"
  );
  if (existing) {
    log(200);
    return json(200, { ok: true, linkId: existing.id, status: existing.status });
  }

  const link = await createProviderLink(env.DB, {
    ownerAccountId: target.id,
    providerAccountId: session.accountId,
    role: "support",
    status: "invited",
    grantedBy: session.accountId,
  });
  const vault = isProviderTarget ? undefined : (await listVaultsForOwner(env.DB, target.id))[0];
  await insertAccessEvent(env.DB, {
    actorAccountId: session.accountId,
    subjectAccountId: target.id,
    vaultId: vault?.vaultId ?? null,
    action: isProviderTarget ? "support_provider_access_requested" : "support_access_requested",
  });

  log(200);
  return json(200, { ok: true, linkId: link.id, status: "invited", target: isProviderTarget ? "provider" : "patient" });
}

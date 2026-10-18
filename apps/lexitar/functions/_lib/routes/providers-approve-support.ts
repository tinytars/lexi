import { grantBreakGlass, type BreakGlassPolicy } from "@tinytars/vault/break-glass";
import type { Account, AuditStore, ProviderLinkStore } from "@tinytars/vault/stores";
import { can, roleOf } from "../capabilities";
import { logRequest } from "../log";
import { json } from "../http";

// W50 — a provider (clinician) approves a support agent's pending ROSTER request. Unlike the patient
// approval (support-approve.ts), there is no vault/envelope: a provider owns nothing encrypted, so the
// grant is metadata-only — flip the link active with a time-box + consent, audited. On approval support
// can see this provider's roster; opening any patient's record still requires that patient's own consent.
//
// Portable: takes only a Request + Deps, no Cloudflare env/context. functions/api/providers/
// approve-support.ts wraps this with pagesHandler, building Deps from env.

export interface ProvidersApproveSupportDeps {
  requireSession(): Promise<{ accountId: string } | Response>;
  getAccount(id: string): Promise<Account | null>;
  links: ProviderLinkStore;
  audit: AuditStore;
}

const ROUTE = "/api/providers/approve-support";
const POLICY: BreakGlassPolicy = { defaultTtlHours: 72, maxTtlHours: 720 }; // 30 days

export async function providersApproveSupportHandler(request: Request, deps: ProvidersApproveSupportDeps): Promise<Response> {
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await deps.requireSession();
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }

  // Only a provider approves via the crypto-free path; a patient must use support-approve.ts (envelope).
  const me = await deps.getAccount(session.accountId);
  if (!can(roleOf(me), "grant:approve-support")) {
    log(403, "not_provider");
    return json(403, { error: "not a provider" });
  }

  let body: { linkId?: unknown; ttlHours?: unknown };
  try {
    body = await request.json();
  } catch {
    log(400, "bad_json");
    return json(400, { error: "invalid JSON" });
  }
  if (typeof body.linkId !== "string") {
    log(400, "bad_body");
    return json(400, { error: "linkId required" });
  }

  const result = await grantBreakGlass(
    { links: deps.links, audit: deps.audit },
    {
      linkId: body.linkId,
      approverAccountId: session.accountId,
      requestedTtlHours: typeof body.ttlHours === "number" ? body.ttlHours : undefined,
      policy: POLICY,
      consentPrefix: "provider-approved",
      auditAction: "support_provider_access_granted",
      buildAuditMeta: (expiresAt, l) => ({ supportAccountId: l.providerAccountId, expiresAt }),
    }
  );
  if (!result.ok) {
    log(403, "forbidden");
    return json(403, { error: "no pending support request to approve" });
  }

  log(200);
  return json(200, { ok: true, expiresAt: result.expiresAt });
}

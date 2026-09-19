import { grantBreakGlass, type BreakGlassPolicy } from "@tinytars/vault/break-glass";
import type { AuditStore, EnvelopeStore, ProviderLinkStore, VaultRow } from "@tinytars/vault/stores";
import { logRequest } from "../log";
import { json } from "../http";

// W44 P4b — the patient approves a pending support request: wraps their in-memory DEK to the support
// agent's public key client-side (zero-knowledge) and posts the opaque envelope + a time-box. Server
// writes the envelope, flips the link active with an expiry + consent, and audits support_access_granted.
//
// Portable: takes only a Request + Deps, no Cloudflare env/context. functions/api/support/approve.ts
// wraps this with pagesHandler, building Deps from env.

export interface SupportApproveDeps {
  requireSession(): Promise<{ accountId: string } | Response>;
  links: ProviderLinkStore;
  audit: AuditStore;
  envelopes: EnvelopeStore;
  listVaultsForOwner(ownerAccountId: string): Promise<VaultRow[]>;
}

const ROUTE = "/api/support/approve";
const POLICY: BreakGlassPolicy = { defaultTtlHours: 72, maxTtlHours: 720 }; // 30 days

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function supportApproveHandler(request: Request, deps: SupportApproveDeps): Promise<Response> {
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await deps.requireSession();
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }

  let body: { linkId?: unknown; wrappedDEK?: unknown; ephemeralPublicKeyJwk?: unknown; ttlHours?: unknown };
  try {
    body = await request.json();
  } catch {
    log(400, "bad_json");
    return json(400, { error: "invalid JSON" });
  }
  const { linkId, wrappedDEK, ephemeralPublicKeyJwk } = body;
  if (typeof linkId !== "string" || typeof wrappedDEK !== "string" || !ephemeralPublicKeyJwk) {
    log(400, "bad_body");
    return json(400, { error: "linkId, wrappedDEK, ephemeralPublicKeyJwk required" });
  }

  const link = await deps.links.get(linkId);
  if (!link || link.ownerAccountId !== session.accountId || link.role !== "support" || link.status !== "invited") {
    log(403, "forbidden");
    return json(403, { error: "no pending support request to approve" });
  }

  const vault = (await deps.listVaultsForOwner(session.accountId))[0];
  if (!vault) {
    log(400, "no_vault");
    return json(400, { error: "no vault to share" });
  }

  const result = await grantBreakGlass(
    { links: deps.links, audit: deps.audit, envelopes: deps.envelopes },
    {
      linkId,
      approverAccountId: session.accountId,
      requestedTtlHours: typeof body.ttlHours === "number" ? body.ttlHours : undefined,
      policy: POLICY,
      consentPrefix: "patient-approved",
      auditAction: "support_access_granted",
      envelope: { vaultId: vault.vaultId, wrappedDek: base64ToBytes(wrappedDEK), ephemeralPublicKeyJwk },
      buildAuditMeta: (expiresAt, l) => ({ providerAccountId: l.providerAccountId, expiresAt }),
    }
  );
  if (!result.ok) {
    log(403, "forbidden");
    return json(403, { error: "no pending support request to approve" });
  }

  log(200);
  return json(200, { ok: true, expiresAt: result.expiresAt });
}

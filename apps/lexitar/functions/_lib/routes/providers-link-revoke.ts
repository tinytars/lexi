import { revokeBreakGlass } from "@tinytars/vault/break-glass";
import type { AuditStore, EnvelopeStore, ProviderLink, ProviderLinkStore, VaultRow } from "@tinytars/vault/stores";
import { logRequest } from "../log";

// W44 P4 — revoke a provider's access. Only the patient who owns the link may revoke. Deletes the
// provider's envelope (so no NEW read can unwrap the DEK) and marks the link revoked.
// NOTE (open decision #3): this is delete-envelope-only — a provider who already unwrapped the DEK
// still holds it in memory until DEK rotation lands. True forward-secret revocation (re-encrypt under
// a fresh DEK + re-wrap the remaining envelopes) is deferred to a follow-up, tracked in the W44 plan.
//
// Portable: takes only a Request + Deps, no Cloudflare env/context/params. functions/api/providers/
// [link].ts wraps this with pagesHandler, building Deps (including the route's `link` param) from env.

export interface ProvidersLinkRevokeDeps {
  requireSession(): Promise<{ accountId: string } | Response>;
  linkId: string;
  getProviderLink(id: string): Promise<ProviderLink | null>;
  listVaultsForOwner(ownerAccountId: string): Promise<VaultRow[]>;
  links: ProviderLinkStore;
  audit: AuditStore;
  envelopes: EnvelopeStore;
}

const ROUTE = "/api/providers";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function providersLinkRevokeHandler(request: Request, deps: ProvidersLinkRevokeDeps): Promise<Response> {
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await deps.requireSession();
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }

  const link = await deps.getProviderLink(deps.linkId);
  if (!link) {
    log(404, "not_found");
    return json(404, { error: "link not found" });
  }
  // W48 — either side may end the link: the patient (revoke) or the provider (drop from their roster).
  if (link.ownerAccountId !== session.accountId && link.providerAccountId !== session.accountId) {
    log(403, "forbidden");
    return json(403, { error: "not your link to revoke" });
  }

  // Always operate on the PATIENT's vault + the provider's envelope, regardless of who calls.
  const vault = (await deps.listVaultsForOwner(link.ownerAccountId))[0];
  await revokeBreakGlass(
    { links: deps.links, audit: deps.audit, envelopes: deps.envelopes },
    {
      linkId: link.id,
      actorAccountId: session.accountId,
      subjectAccountId: link.ownerAccountId,
      providerAccountId: link.providerAccountId,
      vaultId: vault?.vaultId ?? null,
      // Revoking/denying a support link is a disclosure-audit event (§I); a clinician link isn't.
      auditAction: link.role === "support" ? "support_access_denied" : undefined,
      auditMeta: { providerAccountId: link.providerAccountId },
    }
  );

  log(200);
  return json(200, { ok: true });
}

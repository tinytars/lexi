import { checkBreakGlass } from "@tinytars/vault/break-glass";
import type { Account, AuditStore, Envelope, EnvelopeStore, ProviderLink, ProviderLinkStore, VaultRow } from "@tinytars/vault/stores";
import { can, roleOf } from "../capabilities";
import { logRequest } from "../log";
import { json } from "../http";
import type { SupportAccessNotice } from "./support-notice";

// W44 P4b — the audited moment a support agent ENTERS a patient's account. Verifies an active,
// unexpired support link + envelope, records support_access_opened, and returns the envelope for
// client-side unwrap. An expired grant self-revokes (envelope deleted) and is audited as expired.
// Support NEVER reaches a patient through the (unaudited) clinician /api/providers/patients path.
//
// Portable: takes only a Request + Deps, no Cloudflare env/context. functions/api/support/access.ts
// wraps this with pagesHandler, building Deps from env.

export interface SupportAccessDeps {
  requireSession(): Promise<{ accountId: string } | Response>;
  getAccount(id: string): Promise<Account | null>;
  listPatientsForProvider(providerAccountId: string): Promise<ProviderLink[]>;
  listVaultsForOwner(ownerAccountId: string): Promise<VaultRow[]>;
  /** App-policy read (provider-link + org-recovery aware) — see identity-vault.ts's getEnvelope. */
  getEnvelope(vaultId: string, principalAccountId: string): Promise<Envelope | null>;
  insertAccessEvent(e: { actorAccountId: string; subjectAccountId: string; vaultId?: string | null; action: string; consentRef?: string | null; meta?: unknown }): Promise<unknown>;
  /** Opens already recorded against this consent window — 0 means this one is the first. */
  countOpensInWindow(subjectAccountId: string, consentRef: string): Promise<number>;
  notify: SupportAccessNotice;
  links: ProviderLinkStore;
  audit: AuditStore;
  envelopes: EnvelopeStore;
}

const ROUTE = "/api/support/access";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function supportAccessHandler(request: Request, deps: SupportAccessDeps): Promise<Response> {
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await deps.requireSession();
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }
  const me = await deps.getAccount(session.accountId);
  if (!can(roleOf(me), "support:queue")) {
    log(403, "not_support");
    return json(403, { error: "not a support agent" });
  }

  let body: { ownerAccountId?: unknown };
  try {
    body = await request.json();
  } catch {
    log(400, "bad_json");
    return json(400, { error: "invalid JSON" });
  }
  if (typeof body.ownerAccountId !== "string") {
    log(400, "bad_body");
    return json(400, { error: "ownerAccountId required" });
  }
  const ownerAccountId = body.ownerAccountId;

  const link = (await deps.listPatientsForProvider(session.accountId)).find(
    (l) => l.ownerAccountId === ownerAccountId && l.role === "support" && l.status === "active"
  );
  if (!link) {
    log(403, "no_grant");
    return json(403, { error: "no active support access to this patient" });
  }

  const vault = (await deps.listVaultsForOwner(ownerAccountId))[0];
  const envelope = vault ? await deps.getEnvelope(vault.vaultId, session.accountId) : null;

  // Expired grant → self-revoke (delete the envelope, revoke the link) and audit; deny.
  const check = await checkBreakGlass(
    { links: deps.links, audit: deps.audit },
    {
      link,
      actorAccountId: session.accountId,
      subjectAccountId: ownerAccountId,
      vaultId: vault?.vaultId ?? null,
      expiredAuditAction: "support_access_expired",
      // W44 P4c — can't re-key here (patient offline, zero-knowledge); flag it so the patient's next
      // login rotates the DEK, invalidating any DEK this support agent cached.
      onExpire: vault
        ? async () => {
            await deps.envelopes.deleteEnvelope(vault.vaultId, session.accountId);
            await deps.envelopes.setRotationPending(vault.vaultId, true);
          }
        : undefined,
    }
  );
  if (!check.ok) {
    log(403, "expired");
    return json(403, { error: "support access expired" });
  }

  if (!vault || !envelope) {
    log(403, "no_grant");
    return json(403, { error: "no active support access to this patient" });
  }

  const acct = await deps.getAccount(ownerAccountId);
  // Counted BEFORE the insert, so "first open of this window" is asked of the rows that existed before
  // this one. A grant with no consent ref cannot be windowed, so it is not mailed — the audit row still
  // records the open, and every grant this route can reach is stamped by grantBreakGlass.
  const firstOpen = link.consentRef ? (await deps.countOpensInWindow(ownerAccountId, link.consentRef)) === 0 : false;
  await deps.insertAccessEvent({
    actorAccountId: session.accountId,
    subjectAccountId: ownerAccountId,
    vaultId: vault.vaultId,
    action: "support_access_opened",
    consentRef: link.consentRef,
  });
  // Once per window, not once per open: an unattended export runs daily for a week against a grant the
  // patient approved once, and a mail per run trains them to ignore the one that matters.
  if (firstOpen) await deps.notify({ ownerAccountId, event: "opened", expiresAt: link.expiresAt });

  log(200);
  return json(200, {
    ownerAccountId,
    displayName: acct?.displayName ?? ownerAccountId,
    email: acct?.email ?? null,
    vaultId: vault.vaultId,
    r2Key: vault.r2Key,
    envelope: {
      wrappedDEK: bytesToBase64(envelope.wrappedDek),
      ephemeralPublicKeyJwk: envelope.ephemeralPublicKeyJwk,
    },
  });
}

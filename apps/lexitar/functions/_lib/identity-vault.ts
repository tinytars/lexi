// CRUD moved to @tinytars/vault's D1EnvelopeStore (Cloudflare-independence milestone — see
// docs/cross-app/10-open-source-info-security.md); re-exported here so every existing
// "./identity-vault" import site is unchanged. `getEnvelope` stays here — it bakes in this app's
// ORG_ACCOUNT_ID and provider-link policy, which is app-specific, not portable adapter code.
import { D1EnvelopeStore } from "@tinytars/vault/adapters/d1";
import type { D1Database } from "./identity-types";
import { ORG_ACCOUNT_ID } from "./org";
import { getActiveProviderLink } from "./identity-providers";
import { resolveEnvelopeAccess } from "@tinytars/vault/envelope-access";
import type { Envelope, VaultRow } from "@tinytars/vault/stores";

export type { VaultRow, Envelope };

export function createVault(db: D1Database, v: Parameters<D1EnvelopeStore["createVault"]>[0]) {
  return new D1EnvelopeStore(db).createVault(v);
}
export function getVault(db: D1Database, vaultId: string) {
  return new D1EnvelopeStore(db).getVault(vaultId);
}
export function getVaultByR2Key(db: D1Database, r2Key: string) {
  return new D1EnvelopeStore(db).getVaultByR2Key(r2Key);
}
export function getVaultByStagingR2Key(db: D1Database, r2Key: string) {
  return new D1EnvelopeStore(db).getVaultByStagingR2Key(r2Key);
}
export function listVaultsForOwner(db: D1Database, ownerAccountId: string) {
  return new D1EnvelopeStore(db).listVaultsForOwner(ownerAccountId);
}
export function setRotationPending(db: D1Database, vaultId: string, pending: boolean) {
  return new D1EnvelopeStore(db).setRotationPending(vaultId, pending);
}
export function setRotationStaging(db: D1Database, vaultId: string, r2Key: string | null) {
  return new D1EnvelopeStore(db).setRotationStaging(vaultId, r2Key);
}
export function setOrgRecoveryRevoked(db: D1Database, vaultId: string, at: string | null) {
  return new D1EnvelopeStore(db).setOrgRecoveryRevoked(vaultId, at);
}
export function putEnvelope(db: D1Database, e: Parameters<D1EnvelopeStore["putEnvelope"]>[0]) {
  return new D1EnvelopeStore(db).putEnvelope(e);
}
export function replaceEnvelopes(
  db: D1Database,
  vaultId: string,
  envelopes: Parameters<D1EnvelopeStore["replaceEnvelopes"]>[1],
  createdBy: string
) {
  return new D1EnvelopeStore(db).replaceEnvelopes(vaultId, envelopes, createdBy);
}
export function commitRotation(
  db: D1Database,
  vaultId: string,
  newR2Key: string,
  envelopes: Parameters<D1EnvelopeStore["commitRotation"]>[2],
  createdBy: string
) {
  return new D1EnvelopeStore(db).commitRotation(vaultId, newR2Key, envelopes, createdBy);
}
export function getEnvelopeRow(db: D1Database, vaultId: string, principalAccountId: string) {
  return new D1EnvelopeStore(db).getEnvelopeRow(vaultId, principalAccountId);
}
export function listEnvelopesForVault(db: D1Database, vaultId: string) {
  return new D1EnvelopeStore(db).listEnvelopesForVault(vaultId);
}
export function listEnvelopesForPrincipal(db: D1Database, principalAccountId: string) {
  return new D1EnvelopeStore(db).listEnvelopesForPrincipal(principalAccountId);
}
export function deleteEnvelope(db: D1Database, vaultId: string, principalAccountId: string) {
  return new D1EnvelopeStore(db).deleteEnvelope(vaultId, principalAccountId);
}

/**
 * The envelope a principal may actually USE, or null.
 *
 * W71 — the check lives here rather than in each route because that is exactly how it was bypassed.
 * Expiry was enforced lazily and only inside the `support/*` routes: `support/access.ts` self-revokes
 * a lapsed grant, but only if the agent calls that endpoint again. `GET /api/vault/{id}` gated on the
 * envelope row alone, so a support agent who had opened a patient once and kept the id could read
 * full PHI indefinitely by never calling the endpoint that would have revoked them — and nothing was
 * logged. The grant's own expiry was real; nothing consulted it on the path that mattered.
 *
 * The owner needs no link (they have no `provider_links` row about themselves), and neither does the
 * org recovery principal, whose envelope the patient can revoke outright — that revocation is
 * recorded on the vault, not as a link.
 */
export async function getEnvelope(db: D1Database, vaultId: string, principalAccountId: string): Promise<Envelope | null> {
  return resolveEnvelopeAccess(
    { getEnvelopeRow: (v, p) => getEnvelopeRow(db, v, p), getVault: (v) => getVault(db, v) },
    { getActive: (owner, principal) => getActiveProviderLink(db, owner, principal) },
    vaultId,
    principalAccountId,
    ORG_ACCOUNT_ID
  );
}

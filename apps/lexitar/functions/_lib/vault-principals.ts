import type { D1Database } from "./identity-types";
import { getPublicKey } from "./identity-credentials";
import type { VaultRow } from "./identity-vault";
import { listProvidersForPatient } from "./identity-providers";
import { ORG_ACCOUNT_ID } from "./org";

/**
 * W75 — the principals a vault's envelope set MUST contain after a re-key, derived server-side.
 *
 * `rotate` previously accepted any non-empty array that happened to include the caller's own id, so a
 * request that simply omitted the org-recovery principal or an active clinician silently revoked them
 * — the same lockout the route's own header warns about, one principal at a time and with no error.
 * Deriving the set here, from the rows that define access, makes "who keeps access" a server fact
 * rather than something the browser asserts.
 *
 * Order is owner, org recovery (unless the patient revoked it), then active providers — the order the
 * browser builds its re-wrap targets in, so a mismatch reads as a set difference and not a shuffle.
 */
export async function expectedPrincipalIds(db: D1Database, vault: VaultRow): Promise<string[]> {
  const ids = [vault.ownerAccountId];
  if (!vault.orgRecoveryRevokedAt) ids.push(ORG_ACCOUNT_ID);
  for (const link of await listProvidersForPatient(db, vault.ownerAccountId)) {
    if (link.status !== "active") continue;
    // No public key means nothing could have been wrapped to them; requiring the envelope would make
    // every rotation fail rather than surfacing the missing key.
    if (await getPublicKey(db, link.providerAccountId)) ids.push(link.providerAccountId);
  }
  return ids;
}

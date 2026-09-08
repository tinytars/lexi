import type { VaultSession } from "./vault-session.svelte";
import { wrapDEKForPublicKey } from "../security/crypto";
import { bytesToB64 } from "./base64";
import { getVaultPrincipals, putRecoveryEnvelope } from "./auth-recovery";

// W55 P4 — backfill the org-recovery envelope for accounts that predate it (or missed it at signup).
// Best-effort: it must never block or fail an unlock.
export async function ensureOrgRecoveryEnvelope(session: VaultSession): Promise<void> {
  if (!session.dek) return;
  try {
    const principals = await getVaultPrincipals();
    if (principals.orgRecoveryRevokedAt !== null) return;
    if (principals.envelopePrincipalIds.includes(principals.orgAccountId)) return;
    const e = await wrapDEKForPublicKey(session.dek, principals.orgPublicKeyJwk);
    await putRecoveryEnvelope({ wrappedDEK: bytesToB64(e.wrappedDEK), ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk });
  } catch {
    /* best-effort — never block or fail an unlock */
  }
}

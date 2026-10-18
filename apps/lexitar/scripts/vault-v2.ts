// W44 cutover — shared HD1 v2 helpers for the CLI/ops tooling (migrate/vault-verify/reconcile).
// v2 blobs are opened with a DEK, not a passphrase; the DEK reaches the ops pipeline through an
// org-recovery envelope wrapped to the org operational key, which `scripts/org-key.ts` resolves
// from the credential stores and this repository does not track. The envelope's home is D1's
// `vault_envelopes`; the "sidecar" below is the other spelling of the same thing — the envelope in
// a file, `{enc}.dek.enc`, beside a blob in a tree — and nothing here writes one, for the reason
// stated at the foot of this file.

import { loadOrgPublicKey, bytesToB64 } from "./org-key";
import { unwrapVaultDEK, type OrgEnvelope, type OrgKeyAudit } from "./org-unwrap";
import { generateDEK, encryptVaultV2, decryptVaultV2, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

const MAGIC = [0x48, 0x44, 0x31]; // "HD1"
const V2 = 2;

export function isV2(blob: Uint8Array): boolean {
  if (blob.length < 4) return false;
  return MAGIC.every((b, i) => blob[i] === b) && blob[3] === V2;
}

export function sidecarPathFor(encPath: string): string {
  if (!encPath.endsWith(".enc")) throw new Error(`sidecarPathFor: expected a .enc path, got "${encPath}"`);
  return `${encPath.slice(0, -".enc".length)}.dek.enc`;
}

/** A sidecar is that envelope in a file, committed next to the blob. Same shape, different home. */
export type OrgSidecar = OrgEnvelope;

export async function buildV2<T>(
  plain: T,
  dek?: CryptoKey,
): Promise<{ blob: Uint8Array; sidecar: OrgSidecar; dek: CryptoKey }> {
  const usedDek = dek ?? (await generateDEK());
  const blob = await encryptVaultV2(plain, usedDek);
  const env = await wrapDEKForPublicKey(usedDek, loadOrgPublicKey());
  const sidecar: OrgSidecar = {
    wrappedDEK: bytesToB64(env.wrappedDEK),
    ephemeralPublicKeyJwk: env.ephemeralPublicKeyJwk,
  };
  return { blob, sidecar, dek: usedDek };
}

export async function openV2<T>(blob: Uint8Array, sidecar: OrgSidecar, audit: OrgKeyAudit): Promise<T> {
  return decryptVaultV2<T>(blob, await unwrapVaultDEK(sidecar, audit));
}

// Nothing here writes a blob to a file any more, and the three functions that did are deleted
// (2026-10-06, Phase 4(g) of the remediation). The one that mattered is `writeServedVault`, whose
// sidecar-less branch re-encrypted a v1 blob under the vault's **own id** as the passphrase — an id
// that is printed in plaintext in the R2 key and in every log line that names the vault, so the
// blob it wrote opened with no secret at all. Neither live blob is v1, so it never fired; it was a
// loaded gun rather than a wound. It also had no caller: the two its own header named,
// `vault-build.ts`'s CLI and `ingest.ts`'s `persistClientVault`, stayed behind in plover-code's
// `apps/health-dash-web` and have never existed in this repository.
//
// `readSidecar` and `writeSidecar` go with it, because they were reachable only from it. A sidecar
// is a committed `{enc}.dek.enc` file beside a committed blob, which is the `records/public/`
// arrangement Phase 4(b) untracked; the live path reads the same envelope out of D1's
// `vault_envelopes` instead (`vault-restore.ts:240`). `sidecarPathFor` stays, named and tested,
// because the format still has a name even where this tree no longer writes one.

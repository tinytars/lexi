// W44 cutover — shared HD1 v2 helpers for the CLI/ops tooling (migrate/vault-verify/reconcile).
// v2 blobs are opened with a DEK, not a passphrase; the DEK reaches the ops pipeline via an
// org-recovery envelope committed next to the blob (a "sidecar" file, {enc}.dek.enc), wrapped
// to the org operational key (records/org-key.json, see scripts/org-key.ts).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadOrgPublicKey, bytesToB64 } from "./org-key";
import { unwrapVaultDEK, type OrgEnvelope, type OrgKeyAudit } from "./org-unwrap";
import {
  encryptVault,
  generateDEK,
  encryptVaultV2,
  decryptVaultV2,
  wrapDEKForPublicKey,
} from "@tinytars/vault/crypto";

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

export function readSidecar(encPath: string): OrgSidecar {
  return JSON.parse(readFileSync(sidecarPathFor(encPath), "utf8")) as OrgSidecar;
}

export function writeSidecar(encPath: string, sidecar: OrgSidecar): void {
  writeFileSync(sidecarPathFor(encPath), JSON.stringify(sidecar, null, 2));
}

// Format-preserving re-encrypt of the served blob at encPath from a plaintext vault: v2 → same
// DEK (unwrapped from the committed sidecar), v1 → passphrase, missing → new v2 with a fresh DEK
// + sidecar. Shared by vault-build.ts's CLI and ingest.ts's persistClientVault so a direct
// `--client` edit re-derives the SAME format the served blob already has, instead of always
// writing v1 (which would silently strip a v2 vault's owner/provider/support DEK envelopes).
export async function writeServedVault<T>(encPath: string, id: string, vault: T): Promise<void> {
  if (existsSync(encPath) && isV2(new Uint8Array(readFileSync(encPath)))) {
    const dek = await unwrapVaultDEK(readSidecar(encPath), { vaultId: id, purpose: "vault:build:served" });
    writeFileSync(encPath, await encryptVaultV2(vault, dek));
    return;
  }
  if (existsSync(encPath) && !existsSync(sidecarPathFor(encPath))) {
    writeFileSync(encPath, await encryptVault(vault, id));
    return;
  }
  const { blob, sidecar } = await buildV2(vault);
  writeFileSync(encPath, blob);
  writeSidecar(encPath, sidecar);
}

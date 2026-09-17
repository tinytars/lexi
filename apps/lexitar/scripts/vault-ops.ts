// R2/D1-native vault mutation primitive, shared by the eight ops that used to run against
// plover-code's records/private/ plaintext mirror (refresh-finding, refresh-ranges,
// refresh-marker-groups, sync-treatment-attachments, process-pending, reconcile,
// treatment-groups-backfill, treatment-photo-extract — see scripts/commands/r2-ops.ts).
// Generalizes rekey-vault.ts's own pull -> decrypt -> mutate -> encrypt -> push ->
// read-back-verify cycle, this repo's only other full deployed-vault write, so each op composes
// against one proven shape instead of re-deriving it eight times.
//
// No CAS guard on the write: putObject (vault-sync.ts) has no conditional-write option to give
// one, and ops.yml's `concurrency: vault-{client}, cancel-in-progress: false` is what actually
// serializes writes to a given vault. The read-back-verify below catches a half-applied write
// (rekey-vault.ts's own posture), not a concurrent one.

import { normalizeClientId } from "../src/lib/client-id";
import type { Vault, Client } from "../src/lib/types";
import { decryptVaultV2, encryptVaultV2 } from "@tinytars/vault/crypto";
import { orgSidecarFromD1 } from "./org-d1";
import { getObject, putObject, listObjects, LIVE_BUCKET, r2KeyFor } from "./vault-sync";
import { dekFromSidecar, isV2 } from "./vault-v2";

/**
 * Which key inside vault.clients this op targets. vaultId (the R2-key-derived id) is the common
 * case — every current write path (ensureClient, persistClientVault) keys a client's own vault by
 * its own id — but a rekeyed vault (rekey-vault.ts) can leave that id stale inside the ciphertext,
 * so fall back to the vault's sole client rather than guess among several
 * (see src/lib/client-id.ts's vaultIdFromR2Key comment: the two are equal only by convention).
 */
export function resolveClientKey(vault: Vault, vaultId: string): string {
  if (vault.clients[vaultId]) return vaultId;
  const keys = Object.keys(vault.clients);
  if (keys.length === 1) return keys[0];
  throw new Error(
    `no client "${vaultId}" in this vault and it holds ${keys.length}: ` +
      `${keys.map((k) => JSON.stringify(k)).join(", ") || "(none)"} — pass --client with the exact key`,
  );
}

export interface DeployedVault {
  id: string;
  key: string;
  vault: Vault;
  dek: CryptoKey;
  clientKey: string;
  client: Client;
}

export async function pullDeployedVault(vaultId: string, store: string): Promise<DeployedVault> {
  const id = normalizeClientId(vaultId);
  const key = r2KeyFor(store, id);

  const blob = await getObject(LIVE_BUCKET, key);
  if (!blob) throw new Error(`no deployed vault at ${LIVE_BUCKET}/${key}`);
  if (!isV2(blob)) throw new Error(`${key} is not an HD1 v2 blob — only v2 carries the org envelope this needs`);

  const dek = await dekFromSidecar(orgSidecarFromD1(id));
  const vault = await decryptVaultV2<Vault>(blob, dek);
  const clientKey = resolveClientKey(vault, id);
  return { id, key, vault, dek, clientKey, client: vault.clients[clientKey] };
}

export interface VaultOpResult<T> {
  vaultId: string;
  clientKey: string;
  key: string;
  value: T;
  applied: boolean;
}

/**
 * Pull + decrypt a deployed vault, hand `mutate` the one Client this op targets (plus the whole
 * vault and the resolved key, for an op that also needs pendingUploads or replaces the entry
 * wholesale via `vault.clients[clientKey] = next` — using the same key resolveClientKey already
 * settled on, rather than re-deriving it), then push whatever it leaves behind and verify the
 * write reads back. `mutate`'s return value is surfaced to the caller (a count, a summary) —
 * throwing inside it aborts before any write.
 *
 * Caller is responsible for recordOrgKeyUse()/flushOrgKeyUses() around this (access-log.ts) —
 * this module only handles the crypto/IO cycle, not the audit trail.
 */
export async function withDeployedClient<T>(opts: {
  vaultId: string;
  store: string;
  dryRun: boolean;
  mutate: (client: Client, vault: Vault, clientKey: string) => Promise<T> | T;
}): Promise<VaultOpResult<T>> {
  const { vaultId, store, dryRun, mutate } = opts;
  const { id, key, vault, dek, clientKey } = await pullDeployedVault(vaultId, store);

  const value = await mutate(vault.clients[clientKey], vault, clientKey);

  if (dryRun) return { vaultId: id, clientKey, key, value, applied: false };

  await putObject(LIVE_BUCKET, key, await encryptVaultV2(vault, dek));

  const back = await getObject(LIVE_BUCKET, key);
  if (!back) throw new Error(`wrote ${key} but it reads back missing`);
  const check = await decryptVaultV2<Vault>(back, dek);
  if (!check.clients[clientKey]) {
    throw new Error(`verify failed for ${key}: client "${clientKey}" missing after write`);
  }

  return { vaultId: id, clientKey, key, value, applied: true };
}

/** Every vault id currently deployed under `store` — `--reconcile` without --client iterates these. */
export async function listDeployedVaultIds(store: string): Promise<string[]> {
  const objects = await listObjects(LIVE_BUCKET, `${store}/data-`);
  return objects
    .map((o) => /^data-(.+)\.enc$/.exec(o.key.slice(`${store}/`.length))?.[1])
    .filter((id): id is string => !!id)
    .sort();
}

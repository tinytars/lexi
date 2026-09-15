// G1 — re-key the `clients` map INSIDE a deployed vault's ciphertext.
//
// The sibling `--rekey-client` moves R2 object keys and `/api/vault/rotate` moves the D1 row, but
// nothing rewrites the clients map inside the blob. On prod that half was done offline as a repo
// edit and pushed; dev only ever got the R2 half, so its vault still keyed "Alex" while its
// objects sat under the uuid — every /api/raw/alex/... 404'd. This closes that gap in place,
// against the deployed blob, so a store whose content has diverged from the repo is fixed without
// copying another store's vault over it.

import { normalizeClientId } from "../../src/lib/client-id";
import type { Vault } from "../../src/lib/types";
import { decryptVaultV2, encryptVaultV2 } from "@tinytars/vault/crypto";
import { recordOrgKeyUse } from "../access-log";
import { orgSidecarFromD1 } from "../org-d1";
import { getObject, putObject, LIVE_BUCKET } from "../vault-sync";
import { dekFromSidecar, isV2 } from "../vault-v2";

export interface RekeyVaultResult {
  key: string;
  oldKey: string;
  newKey: string;
  otherClients: string[];
  results: number;
  applied: boolean;
}

/** Rename one entry of the clients map, preserving insertion order and every other client. */
export function renameClientKey(vault: Vault, oldKey: string, newKey: string): Vault {
  if (oldKey === newKey) throw new Error(`--rekey-vault-client: <old> and <new> are both "${oldKey}"`);
  const present = Object.keys(vault.clients);
  if (!present.includes(oldKey)) {
    throw new Error(`no client "${oldKey}" in this vault — it holds: ${present.map((k) => `"${k}"`).join(", ") || "(none)"}`);
  }
  // Merging two clients would silently drop one's results; that is a data question, not a rename.
  if (present.includes(newKey)) throw new Error(`this vault already has a client "${newKey}" — refusing to merge`);
  const clients: Vault["clients"] = {};
  for (const [k, c] of Object.entries(vault.clients)) clients[k === oldKey ? newKey : k] = c;
  return { ...vault, clients };
}

export async function rekeyDeployedVaultClient(
  vaultId: string,
  oldKey: string,
  newKey: string,
  store: string,
  dryRun = false,
): Promise<RekeyVaultResult> {
  const id = normalizeClientId(vaultId);
  const key = `${store}/data-${id}.enc`;

  const blob = await getObject(LIVE_BUCKET, key);
  if (!blob) throw new Error(`no deployed vault at ${LIVE_BUCKET}/${key}`);
  if (!isV2(blob)) throw new Error(`${key} is not an HD1 v2 blob — only v2 carries the org envelope this needs`);

  // Reused for the re-encrypt: a fresh DEK would strand every owner/provider/support envelope in D1.
  const dek = await dekFromSidecar(orgSidecarFromD1(id));
  recordOrgKeyUse({ clientId: id, purpose: "ingest:rekey-vault-client" });
  const vault = await decryptVaultV2<Vault>(blob, dek);

  const next = renameClientKey(vault, oldKey, newKey);
  const result: RekeyVaultResult = {
    key,
    oldKey,
    newKey,
    otherClients: Object.keys(vault.clients).filter((k) => k !== oldKey),
    results: next.clients[newKey].results.length,
    applied: false,
  };

  const plan =
    `${dryRun ? "[dry-run] " : ""}${LIVE_BUCKET}/${key}\n` +
    `  clients: ${JSON.stringify(oldKey)} -> ${JSON.stringify(newKey)}` +
    ` (displayName ${JSON.stringify(next.clients[newKey].displayName)} unchanged, ${result.results} result(s))\n` +
    `  untouched: ${result.otherClients.map((k) => JSON.stringify(k)).join(", ") || "(no other clients)"}\n`;
  process.stdout.write(plan);

  if (dryRun) {
    process.stdout.write("  nothing written.\n");
    return result;
  }

  await putObject(LIVE_BUCKET, key, await encryptVaultV2(next, dek));

  // Read back rather than trust the PUT: this is the only write, and a half-applied one is invisible.
  const back = await getObject(LIVE_BUCKET, key);
  if (!back) throw new Error(`wrote ${key} but it reads back missing`);
  const check = await decryptVaultV2<Vault>(back, dek);
  const keys = Object.keys(check.clients);
  if (!keys.includes(newKey) || keys.includes(oldKey)) {
    throw new Error(`verify failed for ${key}: clients are now ${keys.map((k) => `"${k}"`).join(", ")}`);
  }
  process.stdout.write(`  written and verified (${keys.length} client(s)).\n`);
  result.applied = true;
  return result;
}

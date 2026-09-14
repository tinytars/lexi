// W52 Phase 2 — the restore drill, which is the actual deliverable of this milestone.
//
// A backup that has never been restored is not a backup. This reconstructs a chosen snapshot into
// a SCRATCH store prefix (never over the live one, so the drill can run routinely instead of only
// in an emergency), then opens every vault it restored:
//
//   • bytes come from the backup bucket and must match the manifest's sha256
//   • the wrapped DEK comes from the snapshot's D1 dump — NOT from live D1, so the drill proves a
//     restored vault opens using only restored material
//   • every blob must carry the HD1 magic (scripts/vault-v2.ts), decrypt, and parse
//
// Pass condition is that every vault the org LEGITIMATELY holds an envelope for opens — not "a backup
// file exists". A vault the org cannot decrypt is verified to the byte and reported as such; it is the
// intended key custody (only the holder can open it), not a backup defect. See W55.
//
//   npm run vault:restore                      # newest snapshot, scratch prefix, cleaned up after
//   npm run vault:restore -- --snapshot <id>
//   npm run vault:restore -- --store prod           # drill another store's backup lineage
//   npm run vault:restore -- --keep-scratch    # leave the restored objects in place to inspect
//   npm run vault:restore -- --expand-logs     # also re-materialise every audit-log object
//
// Needs ORG_KEY_PASSPHRASE (the org private key unwraps each vault's org-recovery envelope) —
// that is a key, not data, and lives out of band in the operator's private credential store. See VAULT.md §Keys.

import "./load-creds";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  BACKUP_BUCKET,
  LIVE_BUCKET,
  deleteObject,
  getObject,
  listObjects,
  mapPool,
  putObject,
  resolveStore,
} from "./vault-sync";
import {
  latestKey,
  bodyKeyFor,
  manifestKey,
  type LatestPointer,
  type SnapshotManifest,
  type SnapshotObject,
} from "./vault-snapshot";
import { isV2, openV2 } from "./vault-v2";
import { loadOrgPublicKey, bytesToB64, hexToBytes } from "./org-key";
import { recordOrgKeyUse, flushOrgKeyUses } from "./access-log";
import { decryptVault } from "@tinytars/vault/crypto";
import type { Vault } from "../src/lib/types";

const CONCURRENCY = 8;

// Store prefixes a real deployment reads from. Restoring onto one of these would overwrite live
// PHI with older bytes — the single most destructive thing this tool could do, so it is refused
// outright rather than guarded by a flag.
const DEPLOY_STORES = new Set(["dev", "prod", "preview"]);

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface D1Dump {
  database: string;
  tables: {
    accounts?: Array<{ id: string; display_name: string | null; email: string | null }>;
    public_keys?: Array<{ account_id: string; public_key_jwk: string }>;
    vaults?: Array<{ vault_id: string; owner_account_id: string; r2_key: string; hd1_version: number }>;
    vault_envelopes?: Array<{
      vault_id: string;
      principal_account_id: string;
      wrapped_dek: string; // hex — JSON has no bytes type (see vault-snapshot.ts d1DumpJson)
      ephemeral_public_key_jwk: string;
    }>;
  };
}

const sameJwk = (a: JsonWebKey, b: JsonWebKey): boolean =>
  a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y;

async function readJson<T>(bucket: string, key: string): Promise<T> {
  const body = await getObject(bucket, key);
  if (!body) throw new Error(`missing ${bucket}/${key}`);
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

// W75 — backups are namespaced by source store, so "the newest snapshot" is only a question you can
// ask about ONE store. Defaults to the store this worktree deploys to; pass --store to drill another.
export async function latestSnapshotId(store: string): Promise<string> {
  const ptr = await readJson<LatestPointer>(BACKUP_BUCKET, latestKey(store));
  return ptr.snapshotId;
}

// A vault the org holds no envelope for is NOT a backup defect — under the W44 model it is the
// privacy-correct default, and only the account holder's client can ever change it (W55). The drill
// verifies everything it legitimately can for those (bytes match the manifest digest, HD1 magic
// present, object lands at the right key) and reports them as `bytes-only`. Failing on them would
// make the drill permanently red, and a drill nobody reads is the failure mode W52 exists to remove.
export type DrillStatus = "opened" | "bytes-only" | "failed";

export interface VaultDrillResult {
  vaultId: string;
  r2Key: string;
  owner: string;
  status: DrillStatus;
  detail?: string;
}

export interface RestoreReport {
  snapshotId: string;
  scratch: string;
  restored: number;
  logsVerified: number;
  logsExpanded: boolean;
  vaults: VaultDrillResult[];
  orphanBlobs: string[];
  ok: boolean;
}

export interface RestoreOptions {
  store?: string;
  snapshotId?: string;
  scratch?: string;
  keepScratch?: boolean;
  expandLogs?: boolean;
}

// Fetch one snapshotted object's bytes and prove they are the bytes that were captured.
async function fetchBody(
  manifest: SnapshotManifest,
  o: SnapshotObject,
  logBundle: Map<string, string>,
): Promise<Uint8Array> {
  const bytes =
    o.class === "logs"
      ? (() => {
          const text = logBundle.get(o.key);
          if (text === undefined) throw new Error(`log entry absent from the bundle: ${o.key}`);
          return new TextEncoder().encode(text);
        })()
      : await getObject(BACKUP_BUCKET, bodyKeyFor(manifest.store, manifest.snapshotId, o.key));
  if (!bytes) throw new Error(`snapshot object missing from the backup bucket: ${o.key}`);
  const digest = sha256(bytes);
  if (digest !== o.sha256) throw new Error(`restored bytes differ from the manifest digest: ${o.key}`);
  return bytes;
}

export async function restore(opts: RestoreOptions = {}): Promise<RestoreReport> {
  const store = opts.store ?? resolveStore();
  const snapshotId = opts.snapshotId ?? (await latestSnapshotId(store));
  const manifest = await readJson<SnapshotManifest>(BACKUP_BUCKET, manifestKey(store, snapshotId));
  const scratch = opts.scratch ?? `restore-${snapshotId}`;

  if (scratch === manifest.store || DEPLOY_STORES.has(scratch)) {
    throw new Error(`refusing to restore onto the live store prefix "${scratch}" — pick a scratch prefix`);
  }

  process.stdout.write(
    `restoring snapshot ${snapshotId} (store "${manifest.store}", ${manifest.objects.length} object(s)) ` +
      `→ ${LIVE_BUCKET}/${scratch}/\n`,
  );

  const bundleBody = await getObject(BACKUP_BUCKET, manifest.logBundleKey);
  const logBundle = new Map<string, string>(
    (bundleBody ? new TextDecoder().decode(bundleBody).split("\n") : [])
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { key: string; text: string })
      .map((e) => [e.key, e.text] as const),
  );

  // The audit trail is ~25× everything else by object count and contributes nothing to the gate
  // (it is PHI-free operational metadata, not patient data). By default its entries are verified
  // against the manifest digests in memory but not re-materialised as individual R2 objects —
  // stated here and in the report so it can never read as "everything was restored".
  const toRestore = manifest.objects.filter((o) => opts.expandLogs || o.class !== "logs");
  const liveKeyToScratch = (key: string) => `${scratch}/${key.slice(manifest.store.length + 1)}`;

  await mapPool(toRestore, CONCURRENCY, async (o) => {
    const bytes = await fetchBody(manifest, o, logBundle);
    await putObject(LIVE_BUCKET, liveKeyToScratch(o.key), bytes);
  });

  let logsVerified = 0;
  if (!opts.expandLogs) {
    for (const o of manifest.objects.filter((o) => o.class === "logs")) {
      const text = logBundle.get(o.key);
      if (text === undefined) throw new Error(`log entry absent from the bundle: ${o.key}`);
      if (sha256(new TextEncoder().encode(text)) !== o.sha256) {
        throw new Error(`log entry digest mismatch in the bundle: ${o.key}`);
      }
      logsVerified++;
    }
  }

  // ── the gate: open every vault from restored material only ────────────────
  const dump = await readJson<D1Dump>(BACKUP_BUCKET, manifest.d1.jsonKey);
  const vaults = dump.tables.vaults ?? [];
  const envelopes = dump.tables.vault_envelopes ?? [];
  const accounts = new Map((dump.tables.accounts ?? []).map((a) => [a.id, a] as const));

  // Which principal is the org operational key is discovered from the restored public_keys table
  // by matching the committed org public key — no hardcoded account id, no live D1 read.
  const orgPub = loadOrgPublicKey();
  const orgAccountId = (dump.tables.public_keys ?? []).find((r) =>
    sameJwk(JSON.parse(r.public_key_jwk) as JsonWebKey, orgPub),
  )?.account_id;
  if (!orgAccountId && vaults.length) {
    throw new Error(
      "no public_keys row in the snapshot matches records/org-key.json — this snapshot's vaults " +
        "cannot be opened by the org key (wrong org key file, or the snapshot predates it)",
    );
  }

  const results: VaultDrillResult[] = [];
  for (const v of vaults) {
    const owner = accounts.get(v.owner_account_id)?.display_name ?? v.owner_account_id;
    const scratchKey = `${scratch}/${v.r2_key}`;
    try {
      // Read back from R2, not from the copy in memory: the drill has to prove the object landed
      // where an app reading this store prefix would find it.
      const blob = await getObject(LIVE_BUCKET, scratchKey);
      if (!blob) throw new Error(`no restored object at ${scratchKey} (D1 registers it, the snapshot has no such blob)`);
      if (blob.length < 4 || blob[0] !== 0x48 || blob[1] !== 0x44 || blob[2] !== 0x31) {
        throw new Error("not an HD1 blob");
      }
      let vault: Vault;
      if (isV2(blob)) {
        const env = envelopes.find((e) => e.vault_id === v.vault_id && e.principal_account_id === orgAccountId);
        if (!env) {
          // Bytes and placement are already proven above; only the decrypt is out of reach, by design.
          results.push({
            vaultId: v.vault_id,
            r2Key: v.r2_key,
            owner,
            status: "bytes-only",
            detail: "no org envelope — bytes verified, decrypt is the holder's alone (by design)",
          });
          continue;
        }
        recordOrgKeyUse({ clientId: v.r2_key.replace(/^data-/, "").replace(/\.enc$/, ""), purpose: "vault:restore" });
        vault = await openV2<Vault>(blob, {
          wrappedDEK: bytesToB64(hexToBytes(env.wrapped_dek)),
          ephemeralPublicKeyJwk: JSON.parse(env.ephemeral_public_key_jwk) as JsonWebKey,
        });
      } else {
        // Legacy v1 blob: passphrase is the client's lowercase id, which is the r2 key's slug.
        vault = await decryptVault<Vault>(blob, v.r2_key.replace(/^data-/, "").replace(/\.enc$/, ""));
      }
      if (!vault || typeof vault.clients !== "object" || vault.clients === null) {
        throw new Error("decrypted, but the payload is not a vault (no clients map)");
      }
      results.push({ vaultId: v.vault_id, r2Key: v.r2_key, owner, status: "opened" });
    } catch (e) {
      results.push({ vaultId: v.vault_id, r2Key: v.r2_key, owner, status: "failed", detail: (e as Error).message });
    }
  }

  // Vault blobs in the store with no D1 row: nothing registers them, so nothing knows which DEK
  // opens them. Reported loudly rather than skipped — an unopenable blob in the backup is exactly
  // the kind of gap a green drill could otherwise hide.
  const registered = new Set(vaults.map((v) => `${manifest.store}/${v.r2_key}`));
  const orphanBlobs = manifest.objects
    .filter((o) => o.class === "vault" && !registered.has(o.key))
    .map((o) => o.key);

  if (!opts.keepScratch) {
    const written = await listObjects(LIVE_BUCKET, `${scratch}/`);
    await mapPool(written, CONCURRENCY, (o) => deleteObject(LIVE_BUCKET, o.key));
    process.stdout.write(`cleaned up scratch prefix ${scratch}/ (${written.length} object(s))\n`);
  }

  return {
    snapshotId,
    scratch,
    restored: toRestore.length,
    logsVerified,
    logsExpanded: !!opts.expandLogs,
    vaults: results,
    orphanBlobs,
    ok: results.length > 0 && results.every((r) => r.status !== "failed"),
  };
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const report = await restore({
    store: flagValue("store"),
    snapshotId: flagValue("snapshot"),
    scratch: flagValue("scratch"),
    keepScratch: process.argv.includes("--keep-scratch"),
    expandLogs: process.argv.includes("--expand-logs"),
  });

  process.stdout.write(`\nrestored ${report.restored} object(s) to ${report.scratch}/\n`);
  process.stdout.write(
    report.logsExpanded
      ? "audit logs: expanded into the scratch prefix\n"
      : `audit logs: ${report.logsVerified} entr(ies) digest-verified in the bundle, NOT expanded ` +
          "(pass --expand-logs for a full-fidelity restore)\n",
  );
  process.stdout.write("\nvault drill (opened using restored material only):\n");
  const tag = { opened: "ok  ", "bytes-only": "note", failed: "FAIL" } as const;
  for (const r of report.vaults) {
    process.stdout.write(`  ${tag[r.status]} ${r.r2Key.padEnd(46)} ${r.owner}${r.detail ? "  — " + r.detail : ""}\n`);
  }
  for (const k of report.orphanBlobs) {
    process.stdout.write(`  note: ${k} has no vaults row — no envelope, so the drill cannot open it\n`);
  }

  const opened = report.vaults.filter((r) => r.status === "opened").length;
  const bytesOnly = report.vaults.filter((r) => r.status === "bytes-only").length;
  const failed = report.vaults.filter((r) => r.status === "failed");

  if (failed.length) {
    process.stderr.write(
      `\n✗ restore drill FAILED — ${failed.length} of ${report.vaults.length} vault(s) the org CAN open did not.\n` +
        `   That is a backup defect, not a key-custody one.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `\n✓ snapshot ${report.snapshotId}: ${opened} vault(s) restored and opened end to end` +
      (bytesOnly
        ? `; ${bytesOnly} verified to the byte but not decrypted — the org holds no envelope for them, which is\n` +
          `  the intended default. Only the holder's own client can change that (W55).\n`
        : ".\n"),
  );
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main()
    .finally(() => flushOrgKeyUses())
    .catch((e) => {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(1);
    });
}

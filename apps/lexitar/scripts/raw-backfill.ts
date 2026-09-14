// W73 — attribute every pre-existing raw/text/chat object to the account that owns it.
//
// WHY THIS HAS TO EXIST BEFORE THE AUTHORIZATION LANDS. `raw_objects` only started recording ownership
// on 2026-08-25 (migration 0008), so every object written before that is unattributable — and the
// routes now refuse an unclaimed namespace on read. Without this backfill, closing SECURITY.md gap 1
// would lock patients out of their own PDFs, which is why the migration deliberately deferred the
// read-side check to a separate change.
//
// HOW OWNERSHIP IS ESTABLISHED. The namespace segment is a CLIENT KEY that exists only inside the
// encrypted vault, which is the whole reason the server never had an answer. So this decrypts each
// vault with the ORG key — offline, CLI-only, exactly as `recovery-approve.ts` does — reads
// `Object.keys(vault.clients)`, and writes a row per object under each. The live namespace is a MIX of
// account-id keys (newer vaults) and display-name slugs (older ones); both come out of the same place.
//
//   ORG_KEY_PASSPHRASE=… npm run raw:backfill              # report only
//   ORG_KEY_PASSPHRASE=… npm run raw:backfill -- --confirm # write the rows

import "./load-creds";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadOrgPrivateKey } from "./org-key";
import { wranglerTarget } from "./target";
import { listObjects, LIVE_BUCKET, getObject, resolveStore } from "./vault-sync";
import { unwrapDEKWithPrivateKey, decryptVaultV2 } from "@tinytars/vault/crypto";
import { ORG_ACCOUNT_ID } from "../functions/_lib/org";
import type { Vault } from "../src/lib/types";
import { normalizeClientId } from "../src/lib/client-id";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..");
const WRANGLER = resolve(here, "wrangler.sh");
const D1 = wranglerTarget().database;
const STORE = resolveStore();

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function d1<T>(sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("bash", [WRANGLER, "d1", "execute", D1, "--remote", "--json", "--command", sql], {
    cwd: APP,
    maxBuffer: 128 * 1024 * 1024,
  });
  return (JSON.parse(stdout) as Array<{ results: T[] }>)[0].results;
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");

  const vaults = await d1<{ vault_id: string; owner_account_id: string; r2_key: string }>(
    "SELECT vault_id, owner_account_id, r2_key FROM vaults",
  );
  const owned = new Set((await d1<{ r2_key: string }>("SELECT r2_key FROM raw_objects")).map((r) => r.r2_key));

  const live = [
    ...(await listObjects(LIVE_BUCKET, `${STORE}/raw/`)),
    ...(await listObjects(LIVE_BUCKET, `${STORE}/text/`)),
  ].map((o: { key: string }) => o.key);

  process.stdout.write(`Target: ${D1} / ${LIVE_BUCKET} (store "${STORE}")\n`);
  process.stdout.write(`Vaults: ${vaults.length}   live raw+text objects: ${live.length}   already attributed: ${owned.size}\n\n`);

  const orgKey = await loadOrgPrivateKey();
  const clientToOwner = new Map<string, string>();

  for (const v of vaults) {
    const [env] = await d1<{ wrapped_dek: string; ephemeral_public_key_jwk: string }>(
      `SELECT hex(wrapped_dek) AS wrapped_dek, ephemeral_public_key_jwk FROM vault_envelopes WHERE vault_id = ${q(v.vault_id)} AND principal_account_id = ${q(ORG_ACCOUNT_ID)}`,
    );
    if (!env) {
      // A patient who revoked org recovery. Their objects stay unattributed and their namespace stays
      // unclaimed — which, once enforcement is on, means they lose access to their own originals. Named
      // loudly rather than skipped silently, because it is the one case this tool cannot fix.
      process.stdout.write(`  ! ${v.owner_account_id}: no org envelope (revoked) — cannot attribute\n`);
      continue;
    }
    let vault: Vault;
    try {
      const dek = await unwrapDEKWithPrivateKey(
        Uint8Array.from(Buffer.from(env.wrapped_dek, "hex")),
        JSON.parse(env.ephemeral_public_key_jwk) as JsonWebKey,
        orgKey,
      );
      const blob = await getObject(LIVE_BUCKET, `${STORE}/${v.r2_key}`);
      if (!blob) throw new Error(`no blob at ${STORE}/${v.r2_key}`);
      vault = await decryptVaultV2<Vault>(blob, dek);
    } catch (e) {
      process.stdout.write(`  ! ${v.owner_account_id}: could not open vault (${(e as Error).message})\n`);
      continue;
    }
    for (const clientId of Object.keys(vault.clients)) clientToOwner.set(normalizeClientId(clientId), v.owner_account_id);
  }

  // A newer vault keys its first client by the lowercased ACCOUNT ID (src/App.svelte's createFirstClient),
  // so those namespaces are resolvable without opening anything. That matters most for the accounts this
  // tool otherwise cannot reach at all — a patient who revoked org recovery has no envelope for us to
  // use, and would otherwise be locked out of their own originals by the very check meant to protect
  // them.
  for (const a of await d1<{ id: string }>("SELECT id FROM accounts WHERE deleted_at IS NULL")) {
    if (!clientToOwner.has(normalizeClientId(a.id))) clientToOwner.set(normalizeClientId(a.id), a.id);
  }

  process.stdout.write(`\nClient namespaces resolved: ${clientToOwner.size}\n`);

  const toInsert: Array<{ key: string; accountId: string }> = [];
  const orphans: string[] = [];
  for (const key of live) {
    if (owned.has(key)) continue;
    // `{store}/raw/{clientId}/{file}` and `{store}/text/{clientId}/{file}.json`
    const rawClientId = key.split("/")[2];
    const clientId = rawClientId ? normalizeClientId(rawClientId) : undefined;
    const accountId = clientId ? clientToOwner.get(clientId) : undefined;
    if (accountId) toInsert.push({ key, accountId });
    else orphans.push(key);
  }

  process.stdout.write(`Attributable: ${toInsert.length}   orphaned: ${orphans.length}\n`);
  for (const o of orphans.slice(0, 20)) process.stdout.write(`  orphan: ${o}\n`);
  if (orphans.length > 20) process.stdout.write(`  … and ${orphans.length - 20} more\n`);

  if (!confirm) {
    process.stdout.write(`\nReport only. Re-run with --confirm to write ${toInsert.length} ownership rows.\n`);
    return;
  }

  // One statement per row, batched into chunks: INSERT OR IGNORE, so re-running is a no-op and a
  // partial run is safe to resume.
  const CHUNK = 50;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const values = toInsert
      .slice(i, i + CHUNK)
      .map((r) => `(${q(r.key)}, ${q(r.accountId)}, ${q(new Date().toISOString())})`)
      .join(", ");
    await d1(`INSERT OR IGNORE INTO raw_objects (r2_key, account_id, created_at) VALUES ${values}`);
    process.stdout.write(`  wrote ${Math.min(i + CHUNK, toInsert.length)}/${toInsert.length}\n`);
  }

  process.stdout.write(
    `\nDone. ${orphans.length} object(s) remain unattributed. Their namespaces read as UNCLAIMED, which is\n` +
    `ALLOWED (see functions/_lib/raw-owner.ts): an unclaimed namespace has no owner to protect, and\n` +
    `refusing it would lock a patient out of their own files. Each one self-heals the next time anything\n` +
    `writes there. Worth listing them anyway — an orphan usually means a vault this tool could not open.\n`,
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`\n${(e as Error).message}\n`);
    process.exit(1);
  });
}

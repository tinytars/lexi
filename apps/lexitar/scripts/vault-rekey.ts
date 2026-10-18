// Rotate a vault's DATA ENCRYPTION KEY, because the old one is published.
//
// apps/lexitar/migrations/0002_seed_migrated_accounts.sql published, for each seeded account, an EC
// private key wrapped under that account's own slug — with the slug printed in plaintext on the
// adjacent line — plus the wrapped DEK of every vault that account holds an envelope on. So the
// chain slug -> account private key -> wrapped DEK -> DEK -> ciphertext needs no secret at all, and
// it is not undone by deleting an envelope row: whoever cloned the repository between 2026-09-14 and
// 2026-10-06 already holds those bytes. The only thing that ends it is a DEK the published keys
// never wrapped, which means re-encrypting the vault.
//
//   npm run vault:rekey                             # --check (default): report, write NOTHING
//   npm run vault:rekey -- --vault <uuid>           # narrow the report to one vault
//   npm run vault:rekey -- --apply --vault <uuid>   # rotate one vault
//   npm run vault:rekey -- --apply --all            # rotate every vault in this store
//
// WHICH STORE. The worktree decides — scripts/target.ts reads this checkout's wrangler.jsonc for the
// bucket AND the database, and takes only the key prefix from the environment. STORE_PREFIX alone
// moves the prefix and nothing else, which is how a prod checkout once reported on a dev store that
// had never been written there. Run this from a checkout of the branch whose store you mean, or
// override VAULT_BUCKET and D1_DATABASE together. The target is printed before anything remote is
// touched, and --apply prints it again next to the vault count.
//
// WHY IT WRITES TO A NEW R2 KEY. Taken from @tinytars/vault's own D1 adapter, whose rotation used to
// re-encrypt in place: a dropped connection between the blob write and the envelope write locked
// every principal out of the record permanently. Writing the re-encrypted blob to a NEW key makes
// the D1 update the only moment anything becomes true, and leaves the old object readable by the old
// DEK until it is swept. Nothing here deletes it; Phase 4 does, after the rotation is verified.
//
// WHY ONE --command AND NOT THREE. The adapter gets its atomicity from db.batch(), which needs a
// Worker binding this script does not have. A multi-statement `wrangler d1 execute --command` is a
// single implicit transaction instead — measured on dev rather than assumed: two conflicting INSERTs
// in one command failed with APIError 7500 and the valid first insert was rolled back with the
// invalid second. So the DELETE, the INSERTs and the UPDATE go in one call or the vault can end up
// with a new r2_key and the old envelopes, which is unrecoverable.
//
// WHAT IT REFUSES, AND WHY THAT IS THE POINT. A fresh DEK wrapped to a public key whose private half
// was published is a fresh DEK that is already compromised — and the rotation would complete, verify
// and report success. There is nothing in the vault afterwards that says so. So every principal's
// CURRENT public key is thumbprinted and checked against scripts/compromised-public-keys.json, and a
// hit is a refusal. That is what makes "replace the keypairs before rotating the DEK" an invariant
// rather than a sentence in a plan that an operator has to have read.

import "./load-creds";
import { randomUUID } from "node:crypto";
import { generateDEK, encryptVaultV2, decryptVaultV2, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { jwkThumbprint } from "../src/lib/jwk-thumbprint";
import {
  refuseRekey,
  describeRefusal,
  rekeyScope,
  parseRekeyArgs,
  stemOf,
  type Principal,
  type CompromisedKey,
  type RekeyArgs,
} from "../src/lib/vault-rekey-plan";
import compromisedFile from "./compromised-public-keys.json";
import { orgSidecarFromD1 } from "./org-d1";
import { unwrapVaultDEK } from "./org-unwrap";
import { bytesToHex } from "./org-key";
import { d1, q } from "./d1-remote";
import {
  getObject,
  putObject,
  resolveStore,
  assertLiveWriteAllowed,
  LIVE_BUCKET,
  r2KeyFor,
} from "./vault-sync";
import { checkFreshness } from "./vault-snapshot-check";
import { isV2 } from "./vault-v2";
import { flushOrgKeyUses } from "./access-log";
import { describeTarget } from "./target";
import { isMain } from "./is-main";
import type { Vault } from "../src/lib/types";

// Same gate rotate-pilot-credentials.ts uses, and for the same reason: a botched re-wrap is
// recoverable only from the backup, so a stale one is a refusal rather than a warning.
const SNAPSHOT_MAX_AGE_HOURS = 6;
const ORG_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const COMPROMISED = compromisedFile.keys as CompromisedKey[];

export interface VaultRow {
  vault_id: string;
  owner_account_id: string;
  r2_key: string;
  rotation_pending: number;
  rotation_staging_r2_key: string | null;
}

interface EnvelopeRow {
  principal_account_id: string;
  public_key_jwk: string | null;
}

export async function loadVaults(args: RekeyArgs): Promise<VaultRow[]> {
  const where = args.vaultIds.length ? ` WHERE vault_id IN (${args.vaultIds.map(q).join(", ")})` : "";
  const rows = await d1<VaultRow>(
    `SELECT vault_id, owner_account_id, r2_key, rotation_pending, rotation_staging_r2_key FROM vaults${where} ORDER BY vault_id`,
  );
  if (args.vaultIds.length && rows.length !== args.vaultIds.length) {
    const found = new Set(rows.map((r) => r.vault_id));
    throw new Error(`no such vault in this store: ${args.vaultIds.filter((v) => !found.has(v)).join(", ")}`);
  }
  return rows;
}

/**
 * Every principal holding an envelope on this vault, joined to the public key they hold TODAY.
 *
 * The join is the safety-relevant part. The envelope row carries the key the DEK was wrapped to when
 * it was written, which for these vaults is a published key; `public_keys` carries the key the
 * account holds now. Re-wrapping must use the latter, and a principal with no `public_keys` row at
 * all is a stop rather than a skip — silently dropping them from the envelope set would lock them
 * out of the record with no error anywhere.
 */
async function loadPrincipals(vaultId: string): Promise<Principal[]> {
  const rows = await d1<EnvelopeRow>(
    `SELECT e.principal_account_id AS principal_account_id, k.public_key_jwk AS public_key_jwk ` +
      `FROM vault_envelopes e LEFT JOIN public_keys k ON k.account_id = e.principal_account_id ` +
      `WHERE e.vault_id = ${q(vaultId)} ORDER BY e.principal_account_id`,
  );
  const orphans = rows.filter((r) => !r.public_key_jwk).map((r) => r.principal_account_id);
  if (orphans.length) {
    throw new Error(
      `vault ${vaultId}: ${orphans.length} principal(s) hold an envelope but no public_keys row ` +
        `(${orphans.join(", ")}) — re-wrapping would drop them from the record silently`,
    );
  }
  return Promise.all(
    rows.map(async (r) => {
      const publicKeyJwk = JSON.parse(r.public_key_jwk!) as JsonWebKey;
      return { accountId: r.principal_account_id, publicKeyJwk, thumbprint: await jwkThumbprint(publicKeyJwk) };
    }),
  );
}

export interface Assessment {
  row: VaultRow;
  principals: Principal[];
  /** The published keys this vault is actually wrapped to. Empty means it needs nothing. */
  scope: CompromisedKey[];
  refusals: ReturnType<typeof refuseRekey>;
}

export async function assess(row: VaultRow): Promise<Assessment> {
  const principals = await loadPrincipals(row.vault_id);
  const scope = rekeyScope(principals, COMPROMISED);
  // A vault outside the scope is not assessed for refusals at all: it is not going to be rotated,
  // so a refusal against it is a problem reported about work nobody is doing.
  if (!scope.length) return { row, principals, scope, refusals: [] };
  return {
    row,
    principals,
    scope,
    refusals: refuseRekey(
      principals,
      COMPROMISED,
      ORG_ACCOUNT_ID,
      row.rotation_pending !== 0,
      row.rotation_staging_r2_key,
    ),
  };
}

function report(a: Assessment): void {
  const { row, principals, scope, refusals } = a;
  process.stdout.write(`\n${row.vault_id}  ${row.r2_key}\n`);
  for (const p of principals) {
    const hit = COMPROMISED.find((c) => c.thumbprint === p.thumbprint);
    process.stdout.write(
      `  ${p.accountId}  ${p.thumbprint}${hit ? `  <- PUBLISHED (${hit.role})` : ""}` +
        `${p.accountId === ORG_ACCOUNT_ID ? "  [org]" : ""}\n`,
    );
  }
  if (!scope.length) {
    process.stdout.write(`  out of scope — no principal holds a published key, nothing to rotate\n`);
    return;
  }
  if (refusals.length) for (const r of refusals) process.stdout.write(`  REFUSE: ${describeRefusal(r)}\n`);
  else process.stdout.write(`  ready — ${principals.length} envelope(s) would be re-minted\n`);
}

/**
 * Rotate one vault. Order matters at every step and each one is a rollback boundary:
 *
 *   1. open the vault with the CURRENT DEK, through the org envelope
 *   2. write the re-encrypted blob to a NEW r2 key, and read it back before trusting the PUT
 *   3. swap every envelope and repoint the row in ONE atomic D1 call
 *
 * Nothing is destroyed. Up to step 3 the vault is still whole under its old key and the only
 * artifact is an unreferenced blob; after step 3 the old blob is unreferenced instead. There is no
 * moment at which the vault is openable by nobody.
 */
async function rekeyOne(a: Assessment, store: string): Promise<{ vaultId: string; newR2Key: string }> {
  const { row, principals } = a;
  const stem = stemOf(row.r2_key);
  const oldKey = r2KeyFor(store, stem);

  const blob = await getObject(LIVE_BUCKET, oldKey);
  if (!blob) throw new Error(`no vault object at ${LIVE_BUCKET}/${oldKey}`);
  if (!isV2(blob)) throw new Error(`${oldKey} is not an HD1 v2 blob — only v2 carries the org envelope this needs`);

  const dek = await unwrapVaultDEK(orgSidecarFromD1(stem), { vaultId: stem, purpose: "rekey:dek-rotate" });

  // FLUSHED HERE, NOT AT THE END, AND THE ORDERING IS THE WHOLE POINT. access-log.ts resolves a use
  // by `SELECT ... FROM vaults WHERE r2_key IN (...)`, keyed on the stem recorded above — and step 3
  // below repoints `vaults.r2_key` to a brand-new object. So a flush that runs after the repoint
  // looks the stem up against a row that no longer carries it, misses, and is SKIPPED: the skip is
  // deliberate for local-only fixtures (access-log.test.ts pins it) and silently swallowed every
  // org-key decrypt this command made. Measured on dev 2026-10-06 — five vaults rotated, five
  // `access-log: no vault row for "<stem>"` lines, zero rows in `phi_access_events`. Logging it
  // here also dates the row at the access rather than at the end of the sweep. The `.finally()`
  // flush in main() stays as the catch-all for a throw before this line.
  await flushOrgKeyUses();

  const vault = await decryptVaultV2<Vault>(blob, dek);

  // Server-side id, as @tinytars/vault's own two-phase rotation does it: the new object's name must
  // not be anything a caller chose, or a caller can aim the repoint at an object they control.
  const newVaultBlobId = randomUUID().toLowerCase();
  const newR2Key = `data-${newVaultBlobId}.enc`;
  const newStoreKey = r2KeyFor(store, newVaultBlobId);
  if (await getObject(LIVE_BUCKET, newStoreKey)) throw new Error(`${newStoreKey} already exists — refusing to overwrite`);

  const newDek = await generateDEK();
  process.stdout.write(`  re-encrypting -> ${LIVE_BUCKET}/${newStoreKey}\n`);
  await putObject(LIVE_BUCKET, newStoreKey, await encryptVaultV2(vault, newDek));

  // Read back and open with the NEW dek. A PUT that reported success and landed truncated would
  // otherwise be discovered by the repoint, which is the one step that cannot be retried.
  const back = await getObject(LIVE_BUCKET, newStoreKey);
  if (!back) throw new Error(`wrote ${newStoreKey} but it reads back missing`);
  const check = await decryptVaultV2<Vault>(back, newDek);
  if (Object.keys(check.clients).length !== Object.keys(vault.clients).length) {
    throw new Error(`verify failed for ${newStoreKey}: client count changed`);
  }
  process.stdout.write(`  blob verified (${Object.keys(check.clients).length} client(s))\n`);

  const envelopes = await Promise.all(
    principals.map(async (p) => ({ p, env: await wrapDEKForPublicKey(newDek, p.publicKeyJwk) })),
  );
  for (const { p, env } of envelopes) {
    if (!env.wrappedDEK.length) throw new Error(`empty wrapped DEK for ${p.accountId} — refusing to write it`);
  }

  // ONE command, one implicit transaction. A partial apply here is the unrecoverable failure.
  const statements = [
    `DELETE FROM vault_envelopes WHERE vault_id = ${q(row.vault_id)};`,
    ...envelopes.map(
      ({ p, env }) =>
        `INSERT INTO vault_envelopes (vault_id, principal_account_id, wrapped_dek, ephemeral_public_key_jwk, created_by, created_at) ` +
        `VALUES (${q(row.vault_id)}, ${q(p.accountId)}, X'${bytesToHex(env.wrappedDEK)}', ` +
        `${q(JSON.stringify(env.ephemeralPublicKeyJwk))}, ${q("vault-rekey.ts")}, datetime('now'));`,
    ),
    `UPDATE vaults SET r2_key = ${q(newR2Key)}, rotation_staging_r2_key = NULL, rotation_pending = 0 WHERE vault_id = ${q(row.vault_id)};`,
  ];
  await d1(statements.join("\n"));

  // Prove the swap from D1 rather than from the absence of an error.
  const after = await d1<VaultRow>(
    `SELECT vault_id, owner_account_id, r2_key, rotation_pending, rotation_staging_r2_key FROM vaults WHERE vault_id = ${q(row.vault_id)}`,
  );
  if (after[0]?.r2_key !== newR2Key) throw new Error(`repoint did not land: r2_key is ${after[0]?.r2_key}`);
  const now = await loadPrincipals(row.vault_id);
  const want = new Set(principals.map((p) => p.accountId));
  if (now.length !== want.size || now.some((p) => !want.has(p.accountId))) {
    throw new Error(`envelope set after rotation is ${now.map((p) => p.accountId).join(", ")}, expected ${[...want].join(", ")}`);
  }
  process.stdout.write(`  repointed and ${now.length} envelope(s) re-minted — old object left at ${oldKey}\n`);
  return { vaultId: row.vault_id, newR2Key };
}

async function main(): Promise<void> {
  const args = parseRekeyArgs(process.argv.slice(2));
  const store = resolveStore();
  process.stdout.write(`${describeTarget()}\n`);

  const rows = await loadVaults(args);
  if (!rows.length) throw new Error(`no vaults in store "${store}"`);
  const assessments = await Promise.all(rows.map(assess));

  if (!args.apply) {
    process.stdout.write(`\n--check — ${rows.length} vault(s) in store "${store}". Nothing is written.\n`);
    for (const a of assessments) report(a);
    const inScope = assessments.filter((a) => a.scope.length);
    const blocked = inScope.filter((a) => a.refusals.length);
    process.stdout.write(
      `\n${inScope.length} of ${rows.length} vault(s) hold a published key and need rotating; ` +
        `${rows.length - inScope.length} need${rows.length - inScope.length === 1 ? "s" : ""} nothing.\n`,
    );
    process.stdout.write(
      blocked.length
        ? `${blocked.length} of those ${inScope.length} cannot be rotated yet. Rotate the keypairs named above first.\n`
        : `All ${inScope.length} are ready: npm run vault:rekey -- --apply --all\n`,
    );
    process.exit(blocked.length ? 1 : 0);
  }

  assertLiveWriteAllowed(`rotate the DEK of ${rows.length} vault(s) in store "${store}"`);

  // Never rotate what you cannot roll back to.
  const fresh = await checkFreshness(SNAPSHOT_MAX_AGE_HOURS, new Date(), store);
  if (!fresh.ok) {
    throw new Error(`refusing to rotate without a recent backup — ${fresh.reason}\n  run: npm run vault:snapshot`);
  }
  process.stdout.write(`backup ok — snapshot ${fresh.snapshotId} is ${fresh.ageHours!.toFixed(1)}h old\n`);

  // A named --vault outside the scope is a mistake worth naming rather than a silent no-op; under
  // --all it is simply not work.
  const outOfScope = assessments.filter((a) => !a.scope.length);
  if (outOfScope.length && args.vaultIds.length) {
    throw new Error(
      `${outOfScope.map((a) => a.row.vault_id).join(", ")} hold no published key — there is nothing to rotate`,
    );
  }
  const todo = assessments.filter((a) => a.scope.length);
  for (const a of outOfScope) process.stdout.write(`skipping ${a.row.vault_id} — holds no published key\n`);

  // Every refusal is collected before the first write, so a batch cannot get half way and stop.
  const blocked = todo.filter((a) => a.refusals.length);
  if (blocked.length) {
    for (const a of blocked) report(a);
    throw new Error(`refusing to rotate: ${blocked.length} of ${todo.length} in-scope vault(s) are blocked (see above)`);
  }
  if (!todo.length) throw new Error("nothing to rotate — no selected vault holds a published key");

  process.stdout.write(`\napplying to ${todo.length} vault(s) in store "${store}"\n`);
  const done: { vaultId: string; newR2Key: string }[] = [];
  for (const a of todo) {
    process.stdout.write(`\n${a.row.vault_id}\n`);
    done.push(await rekeyOne(a, store));
  }

  process.stdout.write(`\n✓ ${done.length} vault(s) re-keyed:\n`);
  for (const d of done) process.stdout.write(`  ${d.vaultId} -> ${d.newR2Key}\n`);
  process.stdout.write(
    `\nThe published bytes for these vaults are now dead: the wrapped DEKs that migrations/0002 published\n` +
      `until 2026-10-06 — and that every clone taken in those 22 days still holds — wrap a key nothing\n` +
      `references. The old R2 objects are still there, still openable by the old DEK — sweeping them is\n` +
      `Phase 4, after this is verified.\n`,
  );
}

if (isMain(import.meta.url)) {
  main()
    .finally(() => flushOrgKeyUses())
    .catch((e) => {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(1);
    });
}

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
  deleteObject,
  listObjects,
  resolveStore,
  assertLiveWriteAllowed,
  LIVE_BUCKET,
  r2KeyFor,
  r2ChatKeyFor,
  r2RegenLogPrefixFor,
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
// G1 — WHY THIS FILE WALKS chat- AND NOTHING ELSE.
// scripts/commands/rekey.ts:4 already enumerated the five namespaces a re-key has to think about,
// and a rotation that stops at the vault "would leave the patient's chat history ... stranded".
// This command stopped at the vault anyway: it minted a fresh DEK, re-encrypted data-*.enc, and
// DELETEd every old envelope row in the same transaction — so on 2026-10-06 (dev) and 2026-10-07
// (prod) it sealed seven chat histories under a key that no longer exists anywhere. The vault
// still opened, which is why it read as a UI bug: chat-store.ts caught the decrypt failure, armed
// its unreadable guard and refused every save from then on, permanently.
// raw/, text/ and processed/ need no pass of their own — their per-object keys live INSIDE the
// vault (functions/api/raw/[[path]].ts:17), so they travelled with the re-encrypted vault.
// chat- WAS the one namespace sealed under the DEK directly. W87 made that false — see the
// regen-log pass below — and the correction is here rather than only there, because this is the
// sentence a reader checks before concluding a namespace needs no pass.
const chatStagingPrefix = (store: string, vaultBlobId: string): string =>
  `${store}/rekey-chat/${vaultBlobId.toLowerCase()}/`;

interface ChatMove {
  clientId: string;
  liveKey: string;
  stagingKey: string;
}

// WHY A STAGING KEY AND NOT AN IN-PLACE REWRITE, WHICH IS THE WHOLE SAFETY ARGUMENT.
// A chat blob is addressed by its client id and nothing in D1 points at it, so unlike the vault
// it cannot be written to a new key and repointed — the live key is the only address it has.
// That leaves ordering, and both in-place orderings lose data on a crash:
//   re-seal before the D1 commit, and a crash leaves chat on the new DEK with the vault on the
//     old one; the next run mints a DIFFERENT new DEK, and the half-rotated blob is unrecoverable.
//   re-seal after the D1 commit, and a crash leaves chat on the old DEK whose envelopes that
//     same transaction just deleted — which is exactly the loss this fix exists to prevent.
// So the re-seal happens BEFORE the commit and lands somewhere else. Then nothing is destroyed
// until the commit has succeeded, and after it the finish is a pure object copy that needs no key
// at all: whatever sits under the staging prefix is already sealed under the new DEK, so an
// operator can complete an interrupted run with a copy and no secret in hand.
// The prefix sits outside `${store}/chat-`, which orphan-sweep.ts:63 lists and deletes from.
async function resealChatToStaging(
  store: string,
  vault: Vault,
  dek: CryptoKey,
  newDek: CryptoKey,
  newVaultBlobId: string,
): Promise<ChatMove[]> {
  const moves: ChatMove[] = [];
  for (const clientId of Object.keys(vault.clients)) {
    const liveKey = r2ChatKeyFor(store, clientId);
    const blob = await getObject(LIVE_BUCKET, liveKey);
    if (!blob) continue;
    if (!isV2(blob)) {
      throw new Error(
        `chat history for one client is not an HD1 v2 blob — refusing to rotate, because this ` +
          `command cannot re-seal it and completing the rotation would strand it permanently`,
      );
    }
    // Opaque on purpose: the schema belongs to src/lib/chat-store.ts, and a copy of it here is a
    // copy that goes stale. The round trip needs the bytes, not the meaning.
    const hist = await decryptVaultV2<unknown>(blob, dek);
    const size = JSON.stringify(hist).length;
    const stagingKey = `${chatStagingPrefix(store, newVaultBlobId)}chat-${clientId.toLowerCase()}.enc`;
    await putObject(LIVE_BUCKET, stagingKey, await encryptVaultV2(hist, newDek));
    const back = await getObject(LIVE_BUCKET, stagingKey);
    if (!back) throw new Error(`wrote a chat staging object but it reads back missing`);
    if (JSON.stringify(await decryptVaultV2<unknown>(back, newDek)).length !== size) {
      throw new Error(`chat re-seal verify failed: the staged copy does not round-trip`);
    }
    moves.push({ clientId, liveKey, stagingKey });
  }
  // No key is printed. vault-sync.ts:464 is the rule — stdout here can reach a public Actions log
  // and a chat key names a person, so the count is the diagnostic.
  process.stdout.write(`  ${moves.length} chat history(ies) re-sealed to staging\n`);
  return moves;
}

// Runs only after the D1 commit has landed, so the DEK the live app will use is the one these
// bytes are already sealed under. Idempotent per object: the staging copy is deleted last, so a
// crash leaves the remainder of the work sitting under the prefix, finishable by copy alone.
async function promoteChatFromStaging(moves: ChatMove[], newDek: CryptoKey, prefix: string): Promise<void> {
  for (const m of moves) {
    const staged = await getObject(LIVE_BUCKET, m.stagingKey);
    if (!staged) {
      throw new Error(
        `chat staging object vanished before promotion — the remaining histories are under ` +
          `${prefix} and each one copies onto ${"chat-<client>.enc"} with no key needed`,
      );
    }
    await putObject(LIVE_BUCKET, m.liveKey, staged);
    const back = await getObject(LIVE_BUCKET, m.liveKey);
    if (!back) throw new Error(`promoted a chat history but it reads back missing — finish from ${prefix}`);
    await decryptVaultV2<unknown>(back, newDek);
    await deleteObject(LIVE_BUCKET, m.stagingKey);
  }
  if (moves.length) process.stdout.write(`  ${moves.length} chat history(ies) promoted and staging cleared\n`);
}

// Anything left under the prefix is a run that failed between the commit and the promotion, and
// it is PHI sealed under a live DEK. Reported rather than deleted: which half of the rotation it
// belongs to is the operator's call, and this command does not destroy a patient's history.
// Residue is a diagnostic rather than a refusal, and which of the two kinds it is cannot be read
// off the listing — so it names both. A run interrupted AFTER its D1 commit left copies sealed under
// the DEK the envelopes now hold, and those promote onto their live chat- keys with no secret in
// hand. One interrupted BEFORE the commit left copies under a DEK nothing references, which are
// garbage. Neither put a live history at risk: nothing is written to a chat- key until the repoint
// is proved, so the blob the browser reads was never touched by the run that died.
async function reportChatStagingResidue(store: string): Promise<void> {
  const left = await listObjects(LIVE_BUCKET, `${store}/rekey-chat/`);
  if (left.length) {
    process.stdout.write(
      `WARNING: ${left.length} chat staging object(s) remain under ${store}/rekey-chat/ from an ` +
        `earlier interrupted run. If that run reached its D1 commit they are sealed under the DEK in ` +
        `force now and copy onto their live chat- keys as-is; if it did not, they are sealed under a ` +
        `DEK nothing references and are discardable. No live history is at risk either way — the ` +
        `chat- keys themselves were never written.\n`,
    );
  }
}

// W87 — THE REGEN LOG, FOR THE SAME REASON AND IN THE SAME ORDER.
//
// The regen log moved out of the vault blob into `regen-log/{client}/{segment}.enc`, one immutable
// append-only object per save, sealed under the DEK exactly as a chat history is
// (src/lib/regen-log-store.ts). So it needs a pass of its own, and a rotation that skipped it would
// seal a patient's whole regen history under a key that no longer exists anywhere — the 2026-10-06
// loss again, in a namespace that did not exist when that was fixed.
//
// The ordering argument is resealChatToStaging's, unchanged and not restated: re-seal to staging
// before the D1 commit, promote only after the repoint is proved.
//
// A SECOND PAIR OF FUNCTIONS RATHER THAN A GENERALISATION OF THE FIRST, deliberately. The chat path
// is the one that has already failed against real patients and been fixed; parameterising it to
// serve two namespaces means every later change to either one reaches both, in the one file in this
// tree where a mistake destroys a person's history irrecoverably. The duplication is the cheaper
// risk, and what holds the two in step is tests/unit/rekey.test.ts, which asserts the same source
// ordering for both rather than trusting them to be read together.
//
// One structural difference, and it is why the code is not a copy: a chat history is ONE key per
// client, so the chat pass can name it. A regen log is a PREFIX holding any number of segments, so
// this walks the listing — and each segment is re-sealed individually, which also means an
// interrupted run leaves whole segments either done or untouched, never half.
const regenLogStagingPrefix = (store: string, vaultBlobId: string): string =>
  `${store}/rekey-regen-log/${vaultBlobId.toLowerCase()}/`;

interface SegmentMove {
  liveKey: string;
  stagingKey: string;
}

async function resealRegenLogToStaging(
  store: string,
  vault: Vault,
  dek: CryptoKey,
  newDek: CryptoKey,
  newVaultBlobId: string,
): Promise<SegmentMove[]> {
  const moves: SegmentMove[] = [];
  for (const clientId of Object.keys(vault.clients)) {
    const prefix = r2RegenLogPrefixFor(store, clientId);
    for (const obj of await listObjects(LIVE_BUCKET, prefix)) {
      const blob = await getObject(LIVE_BUCKET, obj.key);
      if (!blob) continue;
      if (!isV2(blob)) {
        throw new Error(
          `a regen log segment is not an HD1 v2 blob — refusing to rotate, because this command ` +
            `cannot re-seal it and completing the rotation would strand it permanently`,
        );
      }
      // Opaque on purpose, as the chat path is: the schema belongs to src/lib/regen-log-store.ts,
      // and a copy of it here is a copy that goes stale. The round trip needs the bytes.
      const segment = await decryptVaultV2<unknown>(blob, dek);
      const size = JSON.stringify(segment).length;
      const stagingKey = `${regenLogStagingPrefix(store, newVaultBlobId)}${clientId.toLowerCase()}/${obj.key.slice(prefix.length)}`;
      await putObject(LIVE_BUCKET, stagingKey, await encryptVaultV2(segment, newDek));
      const back = await getObject(LIVE_BUCKET, stagingKey);
      if (!back) throw new Error(`wrote a regen log staging object but it reads back missing`);
      if (JSON.stringify(await decryptVaultV2<unknown>(back, newDek)).length !== size) {
        throw new Error(`regen log re-seal verify failed: the staged copy does not round-trip`);
      }
      moves.push({ liveKey: obj.key, stagingKey });
    }
  }
  // No key is printed — vault-sync.ts's rule: stdout here can reach a public Actions log and one of
  // these keys names a person. The count is the diagnostic.
  process.stdout.write(`  ${moves.length} regen log segment(s) re-sealed to staging\n`);
  return moves;
}

// Runs only after the D1 commit has landed, so the DEK the live app will use is the one these bytes
// are already sealed under. Idempotent per object: the staging copy is deleted last, so a crash
// leaves the remainder under the prefix, finishable by copy alone and with no secret in hand.
async function promoteRegenLogFromStaging(moves: SegmentMove[], newDek: CryptoKey, prefix: string): Promise<void> {
  for (const m of moves) {
    const staged = await getObject(LIVE_BUCKET, m.stagingKey);
    if (!staged) {
      throw new Error(
        `regen log staging object vanished before promotion — the remaining segments are under ` +
          `${prefix} and each one copies back onto regen-log/<client>/ with no key needed`,
      );
    }
    await putObject(LIVE_BUCKET, m.liveKey, staged);
    const back = await getObject(LIVE_BUCKET, m.liveKey);
    if (!back) throw new Error(`promoted a regen log segment but it reads back missing — finish from ${prefix}`);
    await decryptVaultV2<unknown>(back, newDek);
    await deleteObject(LIVE_BUCKET, m.stagingKey);
  }
  if (moves.length) process.stdout.write(`  ${moves.length} regen log segment(s) promoted and staging cleared\n`);
}

// reportChatStagingResidue's argument, applied to this prefix. Reported rather than deleted for the
// same reason: which half of a rotation the residue belongs to is the operator's call, and no live
// segment is at risk either way, because nothing is written to a regen-log/ key until the repoint is
// proved.
async function reportRegenLogStagingResidue(store: string): Promise<void> {
  const left = await listObjects(LIVE_BUCKET, `${store}/rekey-regen-log/`);
  if (left.length) {
    process.stdout.write(
      `WARNING: ${left.length} regen log staging object(s) remain under ${store}/rekey-regen-log/ ` +
        `from an earlier interrupted run. If that run reached its D1 commit they are sealed under the ` +
        `DEK in force now and copy back onto their live regen-log/ keys as-is; if it did not, they are ` +
        `sealed under a DEK nothing references and are discardable. No live segment is at risk either ` +
        `way — the regen-log/ keys themselves were never written.\n`,
    );
  }
}

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

  // BEFORE the transaction, and the ordering is the safety argument — see resealChatToStaging.
  const chatMoves = await resealChatToStaging(store, vault, dek, newDek, newVaultBlobId);
  const regenMoves = await resealRegenLogToStaging(store, vault, dek, newDek, newVaultBlobId);

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
  await promoteChatFromStaging(chatMoves, newDek, chatStagingPrefix(store, newVaultBlobId));
  await promoteRegenLogFromStaging(regenMoves, newDek, regenLogStagingPrefix(store, newVaultBlobId));
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

  // Before the first write, so an earlier interrupted rotation is read out while its residue can
  // still be told apart from this run's. Rotating again is what makes it ambiguous: a second staging
  // prefix appears beside the first, and the DEK that could have opened the first is gone.
  await reportChatStagingResidue(store);
  await reportRegenLogStagingResidue(store);

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

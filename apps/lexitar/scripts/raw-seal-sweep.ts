// Is any raw original or transcription sidecar in this store readable? Answer it with NO KEY.
//
//   npm run raw:seal-sweep        # exits 0 when every object is sealed, 1 the moment one is not
//
// WHY IT MATTERS, and why it is a separate script from raw-encrypt-backfill.ts. That sweep is the
// cure and this one is the alarm, and the difference that decides where each may run is the org
// private key: sealing needs it, so it is barred from a hosted runner by design (docs/OPS-LOCAL.md),
// which meant that for as long as detection and repair were one command NOTHING watched the store.
// Classifying an object needs no key at all — the HD1 envelope announces itself in its first four
// bytes — so this half runs hosted, on a schedule, and reports a store that has drifted back.
//
// IT READS 32 BYTES PER OBJECT, which is the envelope's whole header (@tinytars/vault/crypto). A
// patient document has no business travelling across a CI runner to answer one question about its
// first four bytes, and a `Range` request is what keeps it from having to.
//
// IT NAMES COUNTS AND NEVER KEYS. An R2 key here is `{store}/raw/{account}/{filename}` and the
// filename is the patient's; stdout and stderr both land in a world-readable Actions log. So a
// finding is reported as a class plus `keyRef`'s sha256 prefix, which is enough to go and look with
// the operator tools and not enough to disclose anything (scripts/vault-sync.ts).
//
// IT IS DRIVEN BY BOTH D1 AND THE BUCKET, which is the one place it departs from the backfill it
// otherwise mirrors. The backfill is D1-driven because it has to resolve each namespace to an owner
// before it can mint a key, and only a `raw_objects` row says who that is. A detector needs no owner
// — so the population it must answer for is the STORE, and an object with no row is precisely the
// one a row-driven sweep would never look at. Measured on dev 2026-11-02: 236 rows, of which 70 sat
// in a namespace the backfill could not reach and therefore never classified at all.
import "./load-creds";
import { d1, q, D1 } from "./d1-remote";
import { LIVE_BUCKET, getObjectHead, listObjects, resolveStore, keyRef, classifyKey, mapPool } from "./vault-sync";
import { envelopeVersion } from "../src/lib/raw-cipher";
import { ORG_ACCOUNT_ID } from "../functions/_lib/org";
import { keyringOwner } from "./keyring-owner";
import { isMain } from "./is-main";

const STORE = resolveStore();

// The envelope is `magic(3) | version(1) | vaultKeyId(16) | iv(12)`, and `isSealed` wants the whole
// 32 before it will call anything sealed — so a shorter read would classify a sealed object as
// cleartext and raise an alarm about the thing that is working.
const HEADER_BYTES = 32;

/** The version byte a sealed original carries, mirrored from src/lib/raw-cipher.ts for the report. */
const SEALED = 3;

interface Finding {
  key: string;
  /** The envelope version measured, or null for bytes that are no envelope at all. */
  envelope: number | null;
  /** Whether an operator holding the org key could seal this one. See `reachability` below. */
  operatorSealable: boolean;
}

interface Counts {
  sealed: number;
  missing: number;
  unrecorded: number;
}

/**
 * Per namespace: can the operator lane reach it, or only the owner's own browser?
 *
 * This is what decides whether a finding FAILS the run, and it is the difference between an alarm
 * worth wiring to a nightly job and one that is red from the day it lands. Two classes of cleartext
 * are not the operator's to clear, and raw-encrypt-backfill.ts refuses both on purpose: an ORPHANED
 * namespace, whose bytes stay claimable by whoever proves they own them (functions/api/raw/claim.ts),
 * and an account that has REVOKED org recovery, which is the one lever a patient has to say "not
 * even the operator" and has no --force. For both, `src/lib/raw-seal-heal.ts` in the owner's browser
 * is the only lane, so a nightly that went red over them would be reporting a setting working.
 *
 * Every signal is a D1 column, which is what keeps this half keyless and therefore hostable: who
 * owns the namespace, whether they have a vault, whether recovery is revoked, and whether the org
 * principal still has an envelope on it. Resolved by PREFIX and oldest row first, the way
 * functions/_lib/raw-owner.ts and raw-cipher-cli.ts both resolve it, so an object with no row of its
 * own inherits its namespace's answer rather than counting as orphaned.
 *
 * It then applies scripts/keyring-owner.ts, exactly as the cure does, because an alarm that labels a
 * finding with a different lane from the one the cure would take is worse than silent: it sends the
 * operator to the browser for a file their own command could have sealed. The rule is shared as a
 * pure function rather than copied, and this half supplies `openable` from the three D1 columns
 * below while the cure supplies it by opening the vault — the one asymmetry the module's own header
 * records, and the reason it is a parameter at all.
 */
async function reachability(): Promise<Map<string, boolean>> {
  const rows = await d1<{ r2_key: string; account_id: string | null }>(
    `SELECT r2_key, account_id FROM raw_objects
      WHERE r2_key LIKE ${q(`${STORE}/raw/%`)} OR r2_key LIKE ${q(`${STORE}/text/%`)}
      ORDER BY created_at, rowid`,
  );
  // Every account whose vault this estate's operator lane could open: a vault row, org recovery not
  // revoked, and an envelope for the org principal. The same three conditions raw-cipher-cli.ts's
  // `openableSet` reads, and the same three `openVaultFor` then applies one account at a time.
  const openableRows = await d1<{ owner_account_id: string }>(
    `SELECT v.owner_account_id FROM vaults v
      WHERE v.org_recovery_revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM vault_envelopes e WHERE e.vault_id = v.vault_id AND e.principal_account_id = ${q(ORG_ACCOUNT_ID)})`,
  );
  const openable = new Set(openableRows.map((r) => r.owner_account_id));

  const firstWriter = new Map<string, string | null>();
  for (const row of rows) {
    const slug = slugOf(row.r2_key);
    // Oldest row first and `??`, so the namespace's answer is the one its first row gives — the
    // same tie-break the two resolvers above use, and not whichever row sorted last.
    if (slug && !firstWriter.has(slug)) firstWriter.set(slug, row.account_id);
  }
  const out = new Map<string, boolean>();
  for (const [slug, first] of firstWriter) {
    const owner = keyringOwner(first, slug, (id) => openable.has(id));
    // `keyringOwner` falls back to the first writer when neither account is openable, so the lane is
    // decided by asking of the account it returned — never by the fact that it returned one.
    out.set(slug, Boolean(owner && openable.has(owner)));
  }
  return out;
}

const slugOf = (key: string): string | null => /^[^/]+\/(?:raw|text)\/([^/]+)\//.exec(key)?.[1] ?? null;

/**
 * Every `raw/`- and `text/`-family key in this store, from the table and from the bucket both.
 *
 * Exported because `raw-seal-verify.ts` must answer for the SAME population: a verification that
 * opens a different set of objects from the one the alarm watches proves something about neither.
 */
export async function population(): Promise<{ keys: string[]; recorded: Set<string> }> {
  const rows = await d1<{ r2_key: string }>(
    `SELECT r2_key FROM raw_objects WHERE r2_key LIKE ${q(`${STORE}/raw/%`)} OR r2_key LIKE ${q(`${STORE}/text/%`)} ORDER BY r2_key`,
  );
  const recorded = new Set(rows.map((r) => r.r2_key));
  const listed = (await Promise.all([listObjects(LIVE_BUCKET, `${STORE}/raw/`), listObjects(LIVE_BUCKET, `${STORE}/text/`)])).flat();
  const keys = new Set(recorded);
  // Filtered through the same classifier the backup uses, so a future prefix that merely begins
  // with `raw` cannot widen this sweep's population without being taught to it first.
  for (const o of listed) if (classifyKey(STORE, o.key) === "raw" || classifyKey(STORE, o.key) === "text") keys.add(o.key);
  return { keys: [...keys].sort(), recorded };
}

export async function sweep(say: (line: string) => void): Promise<{ findings: Finding[]; counts: Counts }> {
  const { keys, recorded } = await population();
  const reachable = await reachability();
  say(`Target: ${D1} / ${LIVE_BUCKET} (store "${STORE}")`);
  say(`Objects to classify: ${keys.length}  (${recorded.size} recorded in raw_objects)\n`);

  const findings: Finding[] = [];
  const counts: Counts = { sealed: 0, missing: 0, unrecorded: 0 };
  // The same pool width the snapshot runs at, for the same reason: one round trip per object against
  // an account-wide rate limit (scripts/vault-sync.ts).
  await mapPool(keys, 4, async (key) => {
    if (!recorded.has(key)) counts.unrecorded += 1;
    const head = await getObjectHead(LIVE_BUCKET, key, HEADER_BYTES);
    // A row with no object is NOT a finding here. It is a data-integrity question of its own — 6 of
    // them in production, pre-existing under two slugs — and an absent object discloses nothing.
    if (!head) {
      counts.missing += 1;
      return;
    }
    const envelope = envelopeVersion(head);
    if (envelope === SEALED) counts.sealed += 1;
    else findings.push({ key, envelope, operatorSealable: reachable.get(slugOf(key) ?? "") === true });
  });

  for (const f of findings.sort((a, b) => a.key.localeCompare(b.key))) {
    // `null` is a body that is no envelope — cleartext PHI, the thing this script exists to find.
    // A number other than 3 is the rarer and stranger case: an envelope of the wrong KIND, which is
    // a vault blob (version 2) stored where an original belongs. Both are failures and they are
    // distinguished because the repair differs — the first is sealed, the second is a bug upstream.
    const what = f.envelope === null ? "CLEARTEXT — not an HD1 envelope" : `HD1 version ${f.envelope}, expected ${SEALED}`;
    const lane = f.operatorSealable ? "operator-sealable (npm run raw:encrypt -- --confirm)" : "owner-only — orphaned, or org recovery revoked";
    say(`  ${f.operatorSealable ? "!" : "~"} ${keyRef(f.key)}: ${what} — ${lane}`);
  }
  const sealable = findings.filter((f) => f.operatorSealable);
  say(
    `\nSealed: ${counts.sealed}   unsealed: ${findings.length} (${sealable.length} operator-sealable, ` +
      `${findings.length - sealable.length} owner-only)   rows with no object: ${counts.missing}` +
      `   objects with no row: ${counts.unrecorded}`,
  );
  return { findings, counts };
}

async function main(): Promise<void> {
  const { findings } = await sweep((line) => process.stdout.write(`${line}\n`));
  // Non-zero, and loudly: a sweep whose result nobody reads is the vacuous pass, which is why
  // snapshot.yml runs this as a failing step rather than a reporting one. It fails on the findings
  // an operator can act on, and only those — see `reachability` for why the other class is a line of
  // output rather than a red build.
  const sealable = findings.filter((f) => f.operatorSealable);
  if (sealable.length > 0) {
    process.stderr.write(`\nFAIL: ${sealable.length} object(s) in store "${STORE}" are not sealed and the operator lane can seal them.\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}

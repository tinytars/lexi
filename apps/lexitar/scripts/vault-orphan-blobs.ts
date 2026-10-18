// Phase 4(m) of the published-key-material remediation, as a standing command rather than a
// one-off list — the vault-blob counterpart to scripts/orphan-sweep.ts, which sweeps client
// NAMESPACES (raw/, text/, chat-*.enc) and never touches a vault blob.
//
// WHY THIS EXISTS AT ALL. commitRotation writes the re-keyed blob to a NEW object key and repoints
// vaults.r2_key at it, leaving the old object in place — deliberately, because a repoint that fails
// after a delete has destroyed the only copy. So every `vault:rekey -- --apply` strands one object
// per vault, holding the same plaintext under the PREVIOUS DEK. After the 2026-10 rotation that
// previous DEK is one an attacker holding a clone of the published repository can unwrap, which is
// what makes the sweep part of the remediation rather than housekeeping. Eight objects were stranded
// by that rotation (five on dev, three on prod) and every future rotation strands more, which is why
// this is a command and not a list of keys.
//
//   npm run vault:orphans                        # report only, writes nothing
//   npm run vault:orphans -- --apply             # delete them
//   npm run vault:orphans -- --min-age-hours 0   # include blobs written in the last 24h
//
// FOUR REFUSALS, each for a failure that is silent without it:
//
// 1. AN OBJECT YOUNGER THAN --min-age-hours (24) IS NEVER AN ORPHAN. A rotation in flight has
//    already written its new object and not yet repointed D1, so for that window the new blob looks
//    exactly like an abandoned one. Deleting it destroys the vault. The age guard is the whole
//    reason this command can be run while anything else is running.
// 2. --apply REFUSES WITHOUT A FRESH SNAPSHOT, the same 6h gate replace-keypair.ts and
//    vault-rekey.ts carry. An abandoned blob is still the only copy of its own ciphertext; the undo
//    for this command is vault:restore, which needs a backup to restore from.
// 3. IT DELETES ONLY `{store}/data-*.enc` AT THE TOP LEVEL. Not raw/, not processed/, not text/,
//    not another store's prefix, and not the backup bucket — the prefix is built by the same
//    r2KeyFor the app writes through, so a key shape nothing in the app can produce is not a key
//    this command can delete.
// 4. IT REFUSES A TARGET WHOSE THREE HALVES DISAGREE. A cross-target run needs VAULT_BUCKET,
//    D1_DATABASE and STORE_PREFIX overridden TOGETHER (scripts/target.ts), and that is the one path
//    by which this command can list prod's objects and subtract DEV's claimed keys — which makes
//    every prod blob look abandoned and turns the sweep into a wipe. It needs only one of the three
//    to be forgotten, and nothing downstream would notice: the listing succeeds, the query succeeds,
//    and the count is simply wrong. So the three are checked against each other before anything is
//    listed, which is cheap and is the only refusal here that catches an operator's typo rather than
//    a race. It lives in scripts/target.ts, so the snapshot commands get the same refusal.
//
// The deletion itself goes through deleteObject, which calls assertLiveWriteAllowed — so a live
// store additionally needs PLOVER_ALLOW_LOCAL_VAULT_WRITE=1, by the same rule as every other write.
import "./load-creds";
import { d1, D1 } from "./d1-remote";
import { listObjects, deleteObject, LIVE_BUCKET, r2KeyFor, resolveStore, type R2ObjectInfo } from "./vault-sync";
import { checkFreshness } from "./vault-snapshot-check";
import { describeTarget, assertTargetConsistent } from "./target";
import { isMain } from "./is-main";

const SNAPSHOT_MAX_AGE_HOURS = 6;
const DEFAULT_MIN_AGE_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

/** The top-level vault blobs of one store, by the shape r2KeyFor writes. Excludes raw/ and processed/. */
export const isVaultBlobKey = (store: string, key: string): boolean =>
  new RegExp(`^${store}/data-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.enc$`).test(key);

/**
 * Listed blobs that no `vaults.r2_key` claims and that are older than `minAgeHours`.
 *
 * An object with no `uploaded` field is treated as too young to sweep rather than as ancient: the
 * field is optional in the R2 listing type, and guessing the other way deletes on missing data.
 * That refusal is right and stays — but it is only safe while the field is USUALLY present. The REST
 * list spells the timestamp `last_modified`, `listObjects` read only `uploaded`, and so every object
 * arrived undated: this guard then refused all of them, and the command reported a clean store it had
 * in fact declined to examine. `ageGuardBlindFailure` below is what makes that state loud.
 */
export function orphanBlobs(
  objects: R2ObjectInfo[],
  referenced: Iterable<string>,
  minAgeHours: number,
  now: Date,
): R2ObjectInfo[] {
  const claimed = new Set(referenced);
  return objects.filter((o) => {
    if (claimed.has(o.key)) return false;
    if (minAgeHours <= 0) return true;
    if (!o.uploaded) return false;
    return now.getTime() - Date.parse(o.uploaded) >= minAgeHours * HOUR_MS;
  });
}

/** One `vaults` row, as the two columns that can claim an object come back from D1. */
export interface VaultKeyRow {
  r2_key?: string | null;
  rotation_staging_r2_key?: string | null;
}

/**
 * Every live-store key a `vaults` row claims, in the namespace the R2 listing speaks.
 *
 * TWO DEFECTS THIS REPLACES, both of which made a LIVE blob read as abandoned.
 *
 * THE NAMESPACES DID NOT MATCH. `vaults.r2_key` is `data-{uuid}.enc` with NO store prefix — it is
 * the D1 identifier and the `/api/vault/{id}` route segment at once (functions/api/vault/[id].ts:36
 * looks the route up by that bare form and line 37 builds the R2 key from it with storeKey(); and
 * scripts/access-log.ts:112 matches `WHERE r2_key IN ('data-{id}.enc')`). The R2 listing returns
 * `{store}/data-{uuid}.enc`. The previous code compared the two directly, so the keep-set
 * intersected the listing in NOTHING: every listed blob was classified abandoned, and the only
 * thing between `--apply` and deleting every vault in the store was the 24h age guard — which hid
 * it for exactly as long as the last rotation was less than a day old. vault-rekey.ts:198 does this
 * conversion with this same r2KeyFor; here it was simply missing.
 *
 * A STAGED ROTATION ALSO CLAIMS ITS OBJECT. functions/api/vault/[id].ts:66 serves a blob found by
 * `rotation_staging_r2_key`, so a rotation that has written its new object and not yet committed
 * owns that object even though `r2_key` still names the old one. Reading `r2_key` alone made a
 * staged blob sweepable the moment it aged past the guard.
 *
 * The conversion goes through r2KeyFor rather than string concatenation, so it cannot drift from
 * what the app writes and it applies the same lowercasing. A value that already carries a prefix
 * is taken as given, so a database that ever stores the long form is not double-prefixed into a
 * key matching nothing — which is the failure above, in the other direction.
 */
export function referencedStoreKeys(store: string, rows: VaultKeyRow[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const value of [row.r2_key, row.rotation_staging_r2_key]) {
      const v = value?.trim();
      if (!v) continue;
      if (v.includes("/")) {
        keys.add(v);
        continue;
      }
      const stem = /^data-(.+)\.enc$/.exec(v);
      keys.add(stem ? r2KeyFor(store, stem[1]) : `${store}/${v}`);
    }
  }
  return [...keys];
}

/**
 * REFUSAL 5 — a keep-set that matches nothing is a namespace mismatch, not an empty store.
 *
 * This is the shape the defect above had, and it is the one failure here that cannot be caught by
 * reading the report: "every blob is abandoned" and "the two sides are speaking different key
 * namespaces" print identically. So when rows claim keys and blobs are listed and not one pair
 * matches, the command stops instead of offering to delete the store. A store whose every blob is
 * genuinely abandoned is reachable with --min-age-hours 0 and a deliberate hand, which is the right
 * bar for that being true.
 */
export function keepSetMatchFailure(objects: R2ObjectInfo[], referenced: string[], rowCount: number): string | null {
  if (!objects.length || !rowCount) return null;
  const claimed = new Set(referenced);
  if (objects.some((o) => claimed.has(o.key))) return null;
  return (
    `refusing to sweep: ${rowCount} vaults row(s) claim a key and ${objects.length} vault blob(s) ` +
    `are listed, but NOT ONE matches.\n` +
    `That is what a key-namespace mismatch looks like, and it is indistinguishable from a store in ` +
    `which every blob really is abandoned — so this refuses rather than offer to delete all of ` +
    `them. vaults.r2_key is \`data-{uuid}.enc\`; an R2 key is \`{store}/data-{uuid}.enc\`. Check that ` +
    `referencedStoreKeys still converts between them, and that the store is the one you mean.\n` +
    `  listed:  ${objects[0]?.key}\n` +
    `  claimed: ${referenced[0]}`
  );
}

export function minAgeHours(argv = process.argv): number {
  const i = argv.indexOf("--min-age-hours");
  if (i < 0) return DEFAULT_MIN_AGE_HOURS;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n < 0) throw new Error("--min-age-hours expects a non-negative number");
  return n;
}

/**
 * REFUSAL 6 — the age guard is the only thing standing between `--apply` and an object a rotation is
 * still mid-flight on, and it works by comparing timestamps. An undated object is refused one at a
 * time (see `orphanBlobs`), which is correct per object and invisible in aggregate: if the listing
 * dates NOTHING, every candidate is refused, the report says "Nothing to sweep", and that is
 * indistinguishable from a store that is genuinely clean. It is not a conservative failure — it is a
 * sweep that cannot sweep, so the stranded objects this command exists to remove stay put while the
 * run that was meant to remove them exits 0.
 *
 * So: when the guard is armed and there are unclaimed candidates, at least one of them must be dated.
 * Returns null when there is nothing to say.
 */
export function ageGuardBlindFailure(
  objects: R2ObjectInfo[],
  referenced: Iterable<string>,
  minAgeHours: number,
): string | null {
  if (minAgeHours <= 0) return null; // the guard is off; nothing depends on a timestamp
  const claimed = new Set(referenced);
  const candidates = objects.filter((o) => !claimed.has(o.key));
  if (!candidates.length) return null; // every blob is claimed — a clean store, and a real one
  if (candidates.some((o) => o.uploaded)) return null;
  return (
    `REFUSING to sweep: the R2 listing returned no timestamp for ANY of the ${candidates.length} ` +
    `unclaimed object(s), so the ${minAgeHours}h age guard refused all of them and this run would ` +
    `report nothing to sweep without having examined anything.\n` +
    `That is what a listing whose timestamp field has been renamed looks like. The REST list calls it ` +
    `\`last_modified\`; the Workers binding calls it \`uploaded\`; vault-sync.ts's \`r2ListEntry\` reads ` +
    `both. Check that it still matches what the API returns before trusting this command.\n` +
    `Nothing was written.`
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const store = resolveStore();
  const minAge = minAgeHours();
  const now = new Date();

  process.stdout.write(`${describeTarget()}\n`);

  assertTargetConsistent(store);

  const objects = (await listObjects(LIVE_BUCKET, `${store}/data-`)).filter((o) => isVaultBlobKey(store, o.key));
  const rows = await d1<VaultKeyRow>("SELECT r2_key, rotation_staging_r2_key FROM vaults");
  const referenced = referencedStoreKeys(store, rows);

  const mismatch = keepSetMatchFailure(objects, referenced, rows.length);
  if (mismatch) throw new Error(mismatch);

  const blind = ageGuardBlindFailure(objects, referenced, minAge);
  if (blind) throw new Error(blind);

  const orphans = orphanBlobs(objects, referenced, minAge, now);
  const bytes = orphans.reduce((n, o) => n + o.size, 0);

  // Four numbers rather than two, and the first of them is a MATCH count rather than a row count.
  // The previous line reported `referenced.length` — how many rows D1 returned — which is the same
  // number whether the keep-set matches the listing or not, and is why a keep-set that matched
  // nothing at all printed a report that read as entirely ordinary. These four always sum to the
  // listing, so a wrong one is visible on its face.
  //
  // "Too young" and "undated" are split because summing them hid the second defect behind the
  // first: ten objects written in July printed as "10 too young to sweep", which reads as a healthy
  // store that was rotated an hour ago. They are refused for different reasons and only one of them
  // is a reason to come back tomorrow.
  const claimed = new Set(referenced);
  const stillClaimed = objects.filter((o) => claimed.has(o.key)).length;
  const swept = new Set(orphans.map((o) => o.key));
  const held = objects.filter((o) => !claimed.has(o.key) && !swept.has(o.key));
  const undated = held.filter((o) => !o.uploaded).length;
  const tooYoung = held.length - undated;

  process.stdout.write(
    `\n${D1} / ${LIVE_BUCKET} (store "${store}")   min age: ${minAge}h\n` +
      `${objects.length} vault blob(s) listed = ` +
      `${stillClaimed} claimed by a vaults row + ` +
      `${tooYoung} too young to sweep + ` +
      `${undated} undated, so refused + ` +
      `${orphans.length} abandoned (${bytes} bytes)\n\n`,
  );
  for (const o of orphans) process.stdout.write(`  ${o.key}  ${o.size} bytes  uploaded ${o.uploaded ?? "unknown"}\n`);

  if (!orphans.length) {
    process.stdout.write(`Nothing to sweep.\n`);
    return;
  }
  if (!apply) {
    process.stdout.write(`\nReport only — nothing written. --apply deletes the ${orphans.length} object(s) above.\n`);
    return;
  }

  const fresh = await checkFreshness(SNAPSHOT_MAX_AGE_HOURS, now, store);
  if (!fresh.ok) {
    throw new Error(
      `refusing to delete: ${fresh.reason}\n` +
        `An abandoned blob is still the only copy of its own ciphertext. Run npm run vault:snapshot first.`,
    );
  }

  process.stdout.write(`\nDeleting ${orphans.length} abandoned blob(s)…\n`);
  for (const o of orphans) {
    await deleteObject(LIVE_BUCKET, o.key);
    process.stdout.write(`  deleted ${o.key}\n`);
  }
  process.stdout.write(`Swept ${orphans.length} object(s), ${bytes} bytes.\n`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`\n${(e as Error).message}\n`);
    process.exit(1);
  });
}

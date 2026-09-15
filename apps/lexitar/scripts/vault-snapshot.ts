// W52 Phase 1 — snapshot every live object to a separate backup bucket.
//
// health-dash's beta vaults exist ONLY in R2, and until this milestone there was no backup of
// any kind: records/private/ is a per-branch repo copy that goes stale the moment a user edits
// live (VAULT.md §7 "Reconciliation"), not a user backup.
//
// What a snapshot captures, from the storeKey() call sites (functions/_lib/store.ts, audit.ts):
//
//   {store}/data-{id}.enc      vault ciphertext
//   {store}/chat-{id}.enc      chat history
//   {store}/raw/{id}/{file}    original uploads — PLAINTEXT PHI
//   {store}/processed/{id}/…   extraction artifacts
//   {store}/logs/…             audit trail
//
// …plus a D1 export, which is NOT optional: vault_envelopes.wrapped_dek holds the wrapped DEK for
// every vault, so an R2-only backup restores ciphertext nobody can open.
//
// Any key under {store}/ whose shape classifyKey() doesn't recognise is a HARD FAILURE, not a
// skip — a new key class added to storeKey() elsewhere must not silently fall out of the backup.
//
//   npm run vault:snapshot                 # snapshot + verify + prune to --keep
//   npm run vault:snapshot -- --dry-run    # list + classify only, writes nothing
//   npm run vault:snapshot -- --keep 30    # retention window (default 30)
//   npm run vault:snapshot -- --no-prune   # keep every snapshot this run
//
// Restoring one is scripts/vault-restore.ts — and per W52 a backup that has never been restored
// is not a backup, so the drill is the actual deliverable, not this file.

import "./load-creds";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BACKUP_BUCKET,
  LIVE_BUCKET,
  classifyKey,
  deleteObject,
  getObject,
  listObjects,
  mapPool,
  putObject,
  resolveStore,
  bucketExists,
  type KeyClass,
} from "./vault-sync";
import { wranglerTarget } from "./target";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..");
const WRANGLER = resolve(here, "wrangler.sh");

// W53 P4: derived from the worktree's wrangler.jsonc, not hardcoded — see scripts/target.ts.
export const D1_DATABASE = wranglerTarget().database;
const CONCURRENCY = 8;
const DEFAULT_KEEP = 30;

// Snapshot bodies live under snapshots/{id}/…; the manifest is ALSO written to manifests/{id}.json
// so enumerating snapshots (the alarm, the retention prune) is one small list instead of paging
// through every backed-up object. Same bytes in both places, on purpose.
//
// W75 — every backup key is namespaced by the STORE it was taken from. It was not, and the snapshot
// id is a timestamp: two stores backed up into one bucket did not merely share a retention window,
// they collided on the same manifest key. The retention prune then listed `manifests/` globally,
// sorted, and deleted everything past --keep — so the first prod snapshot would have been deleted
// by the dev nightly, by the job that exists to protect it. The backup BUCKET is per-target now too
// (scripts/target.ts), which is the belt; this is the braces.
//
// This layout change starts a fresh retention lineage: objects written under the old unprefixed
// `snapshots/`, `manifests/` and `latest.json` are not read or pruned by this code any more. Take a
// snapshot immediately after deploying it, or the freshness alarm will (correctly) report that no
// snapshot has ever completed for this store.
const storeRoot = (store: string): string => `stores/${store}/`;
export const snapshotPrefix = (store: string, id: string): string => `${storeRoot(store)}snapshots/${id}/`;
export const manifestKey = (store: string, id: string): string => `${storeRoot(store)}manifests/${id}.json`;
export const latestKey = (store: string): string => `${storeRoot(store)}latest.json`;

export interface SnapshotObject {
  key: string; // the LIVE key, store prefix included
  size: number;
  sha256: string;
  class: KeyClass;
}

export interface SnapshotManifest {
  snapshotId: string;
  createdAt: string;
  store: string;
  sourceBucket: string;
  backupBucket: string;
  counts: Record<KeyClass, number>;
  bytes: number;
  objects: SnapshotObject[];
  logBundleKey: string;
  d1: { database: string; sqlKey: string; jsonKey: string; sqlBytes: number; rows: Record<string, number> };
}

export const logBundleKeyFor = (store: string, id: string): string => `${snapshotPrefix(store, id)}logs.ndjson`;
export const bodyKeyFor = (store: string, id: string, liveKey: string): string => `${snapshotPrefix(store, id)}r2/${liveKey}`;

export interface LatestPointer {
  snapshotId: string;
  createdAt: string;
  store: string;
  objects: number;
  bytes: number;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

// UTC, colon-free so it is safe in an R2 key and still sorts lexicographically by time.
export const snapshotIdFor = (d: Date): string => d.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");

const emptyCounts = (): Record<KeyClass, number> => ({ vault: 0, chat: 0, raw: 0, processed: 0, text: 0, logs: 0 });

// ── D1 ───────────────────────────────────────────────────────────────────────

async function wrangler(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("bash", [WRANGLER, ...args], { cwd: APP, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

async function d1Query<T>(sql: string): Promise<T[]> {
  const out = await wrangler(["d1", "execute", D1_DATABASE, "--remote", "--json", "--command", sql]);
  return (JSON.parse(out) as Array<{ results: T[] }>)[0].results;
}

// Per-table rows as JSON, for the restore drill to read without parsing SQL. BLOB columns are
// hex()-ed because JSON has no bytes type — losing wrapped_dek to a lossy encode would mean a
// backup whose vaults cannot be opened, which is the exact failure this milestone removes.
async function d1DumpJson(): Promise<{ tables: Record<string, Record<string, unknown>[]>; rows: Record<string, number> }> {
  // _cf_KV is D1's own internal table: it exists in sqlite_master but rejects even PRAGMA
  // table_info, so including it fails the whole dump.
  const names = (await d1Query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
      "AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  )).map((r) => r.name);

  const tables: Record<string, Record<string, unknown>[]> = {};
  const rows: Record<string, number> = {};
  for (const t of names) {
    const cols = await d1Query<{ name: string; type: string }>(`PRAGMA table_info("${t}")`);
    const select = cols
      .map((c) => (c.type.toUpperCase() === "BLOB" ? `hex("${c.name}") AS "${c.name}"` : `"${c.name}"`))
      .join(", ");
    tables[t] = await d1Query<Record<string, unknown>>(`SELECT ${select} FROM "${t}"`);
    rows[t] = tables[t].length;
  }
  return { tables, rows };
}

// ── snapshot ─────────────────────────────────────────────────────────────────

export interface SnapshotOptions {
  store?: string;
  dryRun?: boolean;
  keep?: number;
  prune?: boolean;
  now?: Date;
}

export async function snapshot(opts: SnapshotOptions = {}): Promise<SnapshotManifest> {
  const store = resolveStore(opts.store);
  const at = opts.now ?? new Date();
  const id = snapshotIdFor(at);

  if (!(await bucketExists(BACKUP_BUCKET))) {
    throw new Error(
      `backup bucket "${BACKUP_BUCKET}" does not exist — create it once with ` +
        `\`bash scripts/wrangler.sh r2 bucket create ${BACKUP_BUCKET}\``,
    );
  }

  const live = await listObjects(LIVE_BUCKET, `${store}/`);
  const unknown = live.filter((o) => classifyKey(store, o.key) === null);
  if (unknown.length) {
    throw new Error(
      `refusing to snapshot: ${unknown.length} live key(s) under "${store}/" have an unrecognised shape, ` +
        `so this tool cannot promise it captured them. Teach classifyKey() about them first:\n  ` +
        unknown.slice(0, 10).map((o) => o.key).join("\n  "),
    );
  }

  const counts = emptyCounts();
  for (const o of live) counts[classifyKey(store, o.key) as KeyClass]++;
  const liveBytes = live.reduce((n, o) => n + o.size, 0);

  process.stdout.write(`snapshot ${id}  store=${store}  ${live.length} object(s), ${liveBytes} bytes\n`);
  for (const k of Object.keys(counts) as KeyClass[]) process.stdout.write(`  ${k.padEnd(10)} ${counts[k]}\n`);

  if (opts.dryRun) {
    process.stdout.write("\ndry-run — nothing written.\n");
    return {
      snapshotId: id,
      createdAt: at.toISOString(),
      store,
      sourceBucket: LIVE_BUCKET,
      backupBucket: BACKUP_BUCKET,
      counts,
      bytes: liveBytes,
      objects: [],
      logBundleKey: logBundleKeyFor(store, id),
      d1: { database: D1_DATABASE, sqlKey: "", jsonKey: "", sqlBytes: 0, rows: {} },
    };
  }

  // D1 first, deliberately: it is the short step and the one with an external dependency
  // (wrangler), and a snapshot missing its wrapped DEKs is worthless even with every byte of R2 in
  // hand. Failing here costs seconds instead of the seven minutes the R2 copy takes.
  // The .sql export is the authoritative restore artifact (`wrangler d1 execute --file`); the .json
  // alongside it is the machine-readable copy the drill reads envelopes from.
  const sqlTmp = join(tmpdir(), `d1-${randomUUID()}.sql`);
  let sqlBytes = 0;
  try {
    await wrangler(["d1", "export", D1_DATABASE, "--remote", "--output", sqlTmp]);
    const sql = new Uint8Array(await readFile(sqlTmp));
    sqlBytes = sql.length;
    await putObject(BACKUP_BUCKET, `${snapshotPrefix(store, id)}d1/${D1_DATABASE}.sql`, sql);
  } finally {
    await rm(sqlTmp, { force: true });
  }
  const dump = await d1DumpJson();
  await putObject(
    BACKUP_BUCKET,
    `${snapshotPrefix(store, id)}d1/${D1_DATABASE}.json`,
    new TextEncoder().encode(JSON.stringify({ database: D1_DATABASE, blobsAsHex: true, tables: dump.tables })),
  );
  process.stdout.write(
    `  d1         ${Object.values(dump.rows).reduce((a, b) => a + b, 0)} row(s) across ` +
      `${Object.keys(dump.rows).length} table(s), ${sqlBytes} bytes SQL\n`,
  );

  // R2 → R2, client-side (the REST API has no server-side copy). Two paths, because the audit
  // trail is one tiny object per event and already outnumbers everything else ~25:1:
  //
  //   logs   → ONE NDJSON bundle. 1200 individual PUTs would blow the API rate limit every night
  //            and make pruning a snapshot 1200 DELETEs. Bundling is lossless-checked below.
  //   rest   → object-for-object, so a vault/raw/chat blob is individually addressable in the
  //            backup and restores byte-identical without unpacking anything.
  //
  // Either way every object's sha256 is recorded — that is what the restore drill checks the
  // recovered bytes against.
  const isLog = (o: { key: string }) => classifyKey(store, o.key) === "logs";
  const perObject = live.filter((o) => !isLog(o));
  const logObjects = live.filter(isLog);

  const copied = await mapPool(perObject, CONCURRENCY, async (o): Promise<SnapshotObject> => {
    const body = await getObject(LIVE_BUCKET, o.key);
    if (!body) throw new Error(`live object vanished mid-snapshot: ${o.key}`);
    await putObject(BACKUP_BUCKET, bodyKeyFor(store, id, o.key), body);
    return { key: o.key, size: body.length, sha256: sha256(body), class: classifyKey(store, o.key) as KeyClass };
  });

  const bundled = await mapPool(logObjects, CONCURRENCY, async (o): Promise<{ entry: SnapshotObject; line: string }> => {
    const body = await getObject(LIVE_BUCKET, o.key);
    if (!body) throw new Error(`live object vanished mid-snapshot: ${o.key}`);
    const digest = sha256(body);
    const text = new TextDecoder().decode(body);
    // The bundle carries text, so prove the text round-trips to the exact bytes before trusting it.
    // audit.ts only ever writes JSON.stringify output, so this should never fire — and if it does,
    // a silently mangled audit entry is worse than a failed backup.
    if (sha256(new TextEncoder().encode(text)) !== digest) {
      throw new Error(`log object is not UTF-8 round-trippable, refusing to bundle it: ${o.key}`);
    }
    return {
      entry: { key: o.key, size: body.length, sha256: digest, class: "logs" },
      line: JSON.stringify({ key: o.key, sha256: digest, text }),
    };
  });

  await putObject(
    BACKUP_BUCKET,
    logBundleKeyFor(store, id),
    new TextEncoder().encode(bundled.map((b) => b.line).join("\n") + (bundled.length ? "\n" : "")),
  );

  const objects = [...copied, ...bundled.map((b) => b.entry)];

  const manifest: SnapshotManifest = {
    snapshotId: id,
    createdAt: at.toISOString(),
    store,
    sourceBucket: LIVE_BUCKET,
    backupBucket: BACKUP_BUCKET,
    counts,
    bytes: objects.reduce((n, o) => n + o.size, 0),
    objects,
    logBundleKey: logBundleKeyFor(store, id),
    d1: {
      database: D1_DATABASE,
      sqlKey: `${snapshotPrefix(store, id)}d1/${D1_DATABASE}.sql`,
      jsonKey: `${snapshotPrefix(store, id)}d1/${D1_DATABASE}.json`,
      sqlBytes,
      rows: dump.rows,
    },
  };

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  await putObject(BACKUP_BUCKET, `${snapshotPrefix(store, id)}manifest.json`, manifestBytes);
  await putObject(BACKUP_BUCKET, manifestKey(store, id), manifestBytes);

  const latest: LatestPointer = {
    snapshotId: id,
    createdAt: manifest.createdAt,
    store,
    objects: objects.length,
    bytes: manifest.bytes,
  };
  await putObject(BACKUP_BUCKET, latestKey(store), new TextEncoder().encode(JSON.stringify(latest, null, 2)));

  process.stdout.write(`\n✓ ${objects.length} object(s) + D1 → ${BACKUP_BUCKET}/${snapshotPrefix(store, id)}\n`);
  return manifest;
}

// W52 verification #1: the snapshot is only trustworthy if the objects that landed in the backup
// are exactly the objects that were live. Re-lists BOTH sides and reports the diff per key class.
export interface VerifyReport {
  ok: boolean;
  missing: string[]; // live at verify time, absent from the snapshot
  extra: string[]; // in the snapshot, no longer live (an intervening delete — informational)
  sizeMismatch: string[];
  counts: Record<KeyClass, { live: number; snapshot: number }>;
}

export async function verifySnapshot(manifest: SnapshotManifest): Promise<VerifyReport> {
  const store = manifest.store;
  const id = manifest.snapshotId;
  const live = await listObjects(LIVE_BUCKET, `${store}/`);
  const stored = new Map((await listObjects(BACKUP_BUCKET, snapshotPrefix(manifest.store, id))).map((o) => [o.key, o] as const));
  const claimed = new Map(manifest.objects.map((o) => [o.key, o] as const));

  const missing: string[] = [];
  const sizeMismatch: string[] = [];
  const counts = Object.fromEntries(
    (Object.keys(emptyCounts()) as KeyClass[]).map((k) => [k, { live: 0, snapshot: 0 }]),
  ) as Record<KeyClass, { live: number; snapshot: number }>;

  for (const o of live) {
    const cls = classifyKey(store, o.key);
    if (cls) counts[cls].live++;
    const c = claimed.get(o.key);
    if (!c) {
      missing.push(o.key);
      continue;
    }
    if (c.size !== o.size) sizeMismatch.push(`${o.key} (live ${o.size} ≠ snapshot ${c.size})`);
  }
  for (const o of manifest.objects) counts[o.class].snapshot++;

  // The manifest is a claim; these two checks are what make it evidence. Every non-log object must
  // really be in the backup at the recorded size, and the log bundle must really contain every log
  // entry at the recorded digest — otherwise "backed up" means only "listed in a JSON file".
  for (const o of manifest.objects) {
    if (o.class === "logs") continue;
    const s = stored.get(bodyKeyFor(manifest.store, id, o.key));
    if (!s) missing.push(`${o.key} (manifest claims it, backup has no object)`);
    else if (s.size !== o.size) sizeMismatch.push(`${o.key} (manifest ${o.size} ≠ backup ${s.size})`);
  }

  const logEntries = manifest.objects.filter((o) => o.class === "logs");
  const bundle = await getObject(BACKUP_BUCKET, manifest.logBundleKey);
  if (!bundle && logEntries.length) {
    missing.push(`${manifest.logBundleKey} (log bundle absent, ${logEntries.length} entries claimed)`);
  } else if (bundle) {
    const inBundle = new Map(
      new TextDecoder()
        .decode(bundle)
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { key: string; sha256: string })
        .map((e) => [e.key, e.sha256] as const),
    );
    for (const o of logEntries) {
      const d = inBundle.get(o.key);
      if (!d) missing.push(`${o.key} (claimed in manifest, absent from the log bundle)`);
      else if (d !== o.sha256) sizeMismatch.push(`${o.key} (log bundle digest ≠ manifest digest)`);
    }
  }

  const liveKeys = new Set(live.map((o) => o.key));
  const extra = manifest.objects.map((o) => o.key).filter((k) => !liveKeys.has(k));

  return { ok: missing.length === 0 && sizeMismatch.length === 0, missing, extra, sizeMismatch, counts };
}

// ── retention ────────────────────────────────────────────────────────────────

export async function listSnapshotIds(store = resolveStore()): Promise<string[]> {
  const prefix = `${storeRoot(store)}manifests/`;
  const manifests = await listObjects(BACKUP_BUCKET, prefix);
  return manifests
    .map((o) => o.key.slice(prefix.length).replace(/\.json$/, ""))
    .filter(Boolean)
    .sort();
}

// The inverse of snapshotIdFor: the time-of-day separators are dashes so the id is R2-key-safe.
export function parseSnapshotId(id: string): Date | null {
  const m = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A snapshot dir with no manifest is a run that died partway — its bodies are unreferenced and
// would otherwise accumulate forever, since listSnapshotIds() (correctly) can't see them.
// The grace window keeps this from deleting a snapshot that is being written right now.
const INCOMPLETE_GRACE_MS = 6 * 60 * 60 * 1000;

// Which snapshots fall outside the retention window. Split out because an off-by-one here deletes
// the newest backup instead of the oldest, and that is not something to discover in production.
export const idsToPrune = (ids: string[], keep: number): string[] =>
  [...ids].sort().slice(0, Math.max(0, ids.length - keep));

async function deleteSnapshot(store: string, id: string): Promise<number> {
  const objs = await listObjects(BACKUP_BUCKET, snapshotPrefix(store, id));
  await mapPool(objs, CONCURRENCY, (o) => deleteObject(BACKUP_BUCKET, o.key));
  await deleteObject(BACKUP_BUCKET, manifestKey(store, id));
  return objs.length;
}

// Keep the newest `keep` snapshots, delete the rest whole (bodies + manifest), and sweep aborted
// runs. Deletes only under THIS store's stores/{store}/snapshots/{id}/ and manifests/{id}.json —
// never latest.json, never another store's namespace, never a live-store key.
export async function prune(keep: number, now = new Date(), store = resolveStore()): Promise<{ pruned: string[]; incomplete: string[] }> {
  const complete = await listSnapshotIds(store);
  const snapshotsRoot = `${storeRoot(store)}snapshots/`;
  const dirIds = new Set(
    (await listObjects(BACKUP_BUCKET, snapshotsRoot)).map((o) => o.key.slice(snapshotsRoot.length).split("/")[0]).filter(Boolean),
  );
  const incomplete = [...dirIds]
    .filter((id) => !complete.includes(id))
    .filter((id) => {
      const at = parseSnapshotId(id);
      return at !== null && now.getTime() - at.getTime() > INCOMPLETE_GRACE_MS;
    })
    .sort();

  const pruned = idsToPrune(complete, keep);
  for (const id of pruned) process.stdout.write(`pruned snapshot ${id} (${await deleteSnapshot(store, id)} object(s))\n`);
  for (const id of incomplete) {
    process.stdout.write(`swept incomplete snapshot ${id} (${await deleteSnapshot(store, id)} object(s))\n`);
  }
  return { pruned, incomplete };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flagValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const keep = Number(flagValue("keep", String(DEFAULT_KEEP)));
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`--keep must be a positive integer, got "${keep}"`);

  const manifest = await snapshot({ store: flagValue("store", "") || undefined, dryRun, keep });
  if (dryRun) return;

  const report = await verifySnapshot(manifest);
  process.stdout.write("\nverify (live vs snapshot, per key class):\n");
  for (const k of Object.keys(report.counts) as KeyClass[]) {
    const c = report.counts[k];
    process.stdout.write(`  ${k.padEnd(10)} live ${String(c.live).padStart(5)}   snapshot ${String(c.snapshot).padStart(5)}\n`);
  }
  for (const k of report.missing) process.stderr.write(`  MISSING  ${k}\n`);
  for (const k of report.sizeMismatch) process.stderr.write(`  SIZE     ${k}\n`);
  for (const k of report.extra) process.stdout.write(`  note: deleted from live since the copy started — ${k}\n`);
  if (!report.ok) {
    process.stderr.write("\n✗ snapshot verify FAILED — the backup does not cover the live store.\n");
    process.exit(1);
  }

  if (!process.argv.includes("--no-prune")) await prune(keep, new Date(), manifest.store);

  process.stdout.write(`\n✓ snapshot ${manifest.snapshotId} verified. Drill it: npm run vault:restore\n`);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}

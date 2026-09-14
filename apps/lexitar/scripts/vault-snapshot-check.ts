// W52 Phase 4 — the alarm. A silent cron is indistinguishable from no backup at all, so the
// question "did the scheduled snapshot actually run?" has to be asked by something OTHER than the
// cron itself. This is that something: one cheap read of the backup bucket's latest.json, failing
// loudly if it is absent or older than the window.
//
// It runs three places on purpose:
//   • at the end of the scheduled job (scripts/snapshot-cron.sh) — catches a job that "succeeded"
//     without writing anything
//   • in `npm run doctor` — surfaces a dead cron in the ordinary dev loop
//   • wherever an operator asks
//
//   npm run vault:snapshot:check
//   npm run vault:snapshot:check -- --max-age-hours 36

import "./load-creds";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BACKUP_BUCKET, getObject, resolveStore } from "./vault-sync";
import { latestKey, listSnapshotIds, manifestKey, type LatestPointer } from "./vault-snapshot";

// A daily job gets a 36h window: one skipped night is a real failure, but a run that starts late
// or takes an hour must not page anyone.
const DEFAULT_MAX_AGE_HOURS = 36;

export interface FreshnessReport {
  ok: boolean;
  reason?: string;
  snapshotId?: string;
  ageHours?: number;
  snapshots?: number;
}

// W75 — the store is part of the question. There was one global latest.json, so this alarm reported
// green for a store that had never been backed up at all, on the strength of another store's nightly.
// The freshness of dev's backup says nothing about prod's, which is the case the alarm exists for.
export async function checkFreshness(
  maxAgeHours: number,
  now = new Date(),
  store = resolveStore(),
): Promise<FreshnessReport> {
  const pointer = latestKey(store);
  const body = await getObject(BACKUP_BUCKET, pointer);
  if (!body) {
    return { ok: false, reason: `no ${BACKUP_BUCKET}/${pointer} — no snapshot has ever completed for store "${store}"` };
  }
  const latest = JSON.parse(new TextDecoder().decode(body)) as LatestPointer;
  if (latest.store !== store) {
    return {
      ok: false,
      reason: `${pointer} was written from store "${latest.store}", not "${store}" — this alarm is not watching this store`,
      snapshotId: latest.snapshotId,
    };
  }
  const ageHours = (now.getTime() - new Date(latest.createdAt).getTime()) / 3_600_000;

  // latest.json is only a pointer; if the manifest it names is gone the snapshot is not restorable,
  // which is a failure even though the pointer looks fresh.
  const manifest = await getObject(BACKUP_BUCKET, manifestKey(store, latest.snapshotId));
  if (!manifest) {
    return {
      ok: false,
      reason: `${pointer} points at ${latest.snapshotId}, but its manifest is missing — that snapshot cannot be restored`,
      snapshotId: latest.snapshotId,
      ageHours,
    };
  }

  const snapshots = (await listSnapshotIds(store)).length;
  if (ageHours > maxAgeHours) {
    return {
      ok: false,
      reason: `newest snapshot is ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h) — the scheduled backup did not run`,
      snapshotId: latest.snapshotId,
      ageHours,
      snapshots,
    };
  }
  return { ok: true, snapshotId: latest.snapshotId, ageHours, snapshots };
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--max-age-hours");
  const maxAge = i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : DEFAULT_MAX_AGE_HOURS;
  if (!Number.isFinite(maxAge) || maxAge <= 0) throw new Error("--max-age-hours must be a positive number");

  const r = await checkFreshness(maxAge);
  if (!r.ok) {
    process.stderr.write(`✗ BACKUP ALARM — ${r.reason}\n   run: npm run vault:snapshot\n`);
    process.exit(1);
  }
  process.stdout.write(
    `✓ backup fresh — ${r.snapshotId} is ${r.ageHours!.toFixed(1)}h old, ${r.snapshots} snapshot(s) retained\n`,
  );
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}

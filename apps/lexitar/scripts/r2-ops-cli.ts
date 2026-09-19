// CLI entrypoint for the eight R2/D1-native ops (scripts/commands/r2-ops.ts) — the direct
// replacement for scripts/ingest.ts's --refresh-finding/--refresh-ranges/--refresh-marker-groups/
// --process-pending/--reconcile/--sync-treatment-attachments/--treatment-groups-backfill/
// --treatment-photo-extract flags, now that those act on R2/D1 directly instead of plover-code's
// local records/private/ mirror (never ported here). Flag shape intentionally matches ops.yml's
// existing `cmd=` lines so porting that workflow here later is a script-name swap, not a rewrite.
import "./load-creds";
import { parseR2OpsArgs } from "./r2-ops-args";
import { UsageAccumulator } from "./inference-cost";
import { flushOrgKeyUses } from "./access-log";
import { resolveStore } from "./vault-sync";
import {
  opRefreshFinding,
  opRefreshRanges,
  opRefreshMarkerGroups,
  opProcessPending,
  opReconcile,
  opSyncTreatmentAttachments,
  opTreatmentGroupsBackfill,
  opTreatmentPhotoExtract,
  type PendingResult,
  type ReconcileResult,
  type BackfillResult,
  type PhotoExtractResult,
} from "./commands/r2-ops";
import type { VaultOpResult } from "./vault-ops";
import { isMain } from "./is-main";

function reportApplied(dryRun: boolean, applied: boolean): void {
  process.stdout.write(applied ? "Applied — pushed to R2.\n" : dryRun ? "Dry run — no R2 write.\n" : "Nothing to apply.\n");
}

function reportPending(result: PendingResult): void {
  process.stdout.write(`Folded: ${result.processed.length}   still pending: ${result.stillPending.length}\n`);
  for (const f of result.failures) process.stdout.write(`  ${f.id}: ${f.message}\n`);
}

function reportBackfill(result: BackfillResult): void {
  process.stdout.write(result.nodes.length ? `Nodes: ${result.nodes.join(", ")}\n` : "Nothing stale.\n");
  for (const f of result.failures) process.stdout.write(`  ${f.node}: ${f.message}\n`);
}

function reportPhotoExtract(result: PhotoExtractResult): void {
  process.stdout.write(`Rows touched: ${result.rowIds.join(", ")}\n`);
  if (result.proposed) process.stdout.write(`${JSON.stringify(result.proposed, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseR2OpsArgs(process.argv.slice(2));
  const store = resolveStore(args.store);
  const usage = new UsageAccumulator();
  const base = { store, dryRun: args.dryRun, force: args.force, mode: args.mode };

  switch (args.op) {
    case "refresh-finding": {
      const r = await opRefreshFinding({ ...base, vaultId: args.client! }, usage);
      reportApplied(args.dryRun, r.applied);
      break;
    }
    case "refresh-ranges": {
      const ranges = { refreshMarkers: args.marker ? [args.marker] : [], allMarkers: args.allMarkers, force: args.force };
      const r = await opRefreshRanges({ ...base, vaultId: args.client! }, ranges, usage);
      reportApplied(args.dryRun, r.applied);
      break;
    }
    case "refresh-marker-groups": {
      const r = await opRefreshMarkerGroups({ ...base, vaultId: args.client! }, usage);
      reportApplied(args.dryRun, r.applied);
      break;
    }
    case "sync-treatment-attachments": {
      const r: VaultOpResult<number> = await opSyncTreatmentAttachments({ ...base, vaultId: args.client! }, args.name);
      process.stdout.write(`Attachments added: ${r.value}\n`);
      reportApplied(args.dryRun, r.applied);
      break;
    }
    case "process-pending": {
      const r = await opProcessPending({ ...base, vaultId: args.client! }, usage);
      reportPending(r.value);
      reportApplied(args.dryRun, r.applied);
      break;
    }
    case "reconcile": {
      const r: ReconcileResult = await opReconcile({ ...base, vaultId: args.client }, usage);
      for (const c of r.clients) {
        process.stdout.write(`${c.vaultId}:\n`);
        reportPending(c.result);
      }
      break;
    }
    case "treatment-groups-backfill": {
      const r = await opTreatmentGroupsBackfill({ ...base, vaultId: args.client! }, usage);
      reportBackfill(r.value);
      reportApplied(args.dryRun, r.applied);
      break;
    }
    case "treatment-photo-extract": {
      const r = await opTreatmentPhotoExtract(
        { ...base, vaultId: args.client! },
        { name: args.name!, rowId: args.rowId, keys: args.keys! },
        usage,
      );
      reportPhotoExtract(r.value);
      reportApplied(args.dryRun, r.applied);
      break;
    }
  }

  if (usage.totalCost() > 0) process.stdout.write(`\n${usage.summary(args.mode)}\n`);
}

if (isMain(import.meta.url)) {
  main()
    .finally(() => flushOrgKeyUses())
    .catch((e) => {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(1);
    });
}

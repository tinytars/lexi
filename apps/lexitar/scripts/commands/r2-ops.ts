// The six ops ops.yml could no longer dispatch once records/private/ stayed behind in
// plover-code (refresh-finding, refresh-ranges, refresh-marker-groups,
// sync-treatment-attachments, process-pending, reconcile) — reimplemented here against R2/D1
// directly, with zero dependency on a local plaintext vault mirror. Each is a thin composition of
// vault-ops.ts's pull/mutate/push cycle around logic this repo already has and the browser/Pages
// Functions path already exercises: refresh.ts's three regen functions, factors.ts's treatment-
// attachment reconciliation, and import-flow.ts's report/source fold functions.

import type { Client, InferenceMode, PendingUpload } from "../../src/lib/types";
import { UsageAccumulator } from "../inference-cost";
import { recordOrgKeyUse } from "../access-log";
import { getObject, r2RawKeyFor, LIVE_BUCKET } from "../vault-sync";
import { withDeployedClient, listDeployedVaultIds } from "../vault-ops";
import { refreshFindingFor, refreshRangesFor, refreshMarkerGroupsFor, type RefreshRangesOptions } from "./refresh";
import { reconcileTreatmentAttachments } from "../factors";
import { foldReport, foldSource } from "../../src/lib/import-flow";
import { proposeFromReport } from "../claude-report";
import { parseRawFile } from "../../src/lib/parse-raw";

export interface OpArgs {
  vaultId: string;
  store: string;
  dryRun: boolean;
  force: boolean;
  mode: InferenceMode;
}

async function run<T>(
  vaultId: string,
  store: string,
  dryRun: boolean,
  purpose: string,
  mutate: (client: Client, vault: import("../../src/lib/types").Vault, clientKey: string) => Promise<T> | T,
) {
  recordOrgKeyUse({ clientId: vaultId, purpose });
  const result = await withDeployedClient({ vaultId, store, dryRun, mutate });
  return result;
}

export async function opRefreshFinding(args: OpArgs, usage: UsageAccumulator) {
  return run(args.vaultId, args.store, args.dryRun, "ingest:refresh-finding", async (client) => {
    await refreshFindingFor(client, args.force, args.mode, usage, args.dryRun);
  });
}

export async function opRefreshRanges(args: OpArgs, ranges: Omit<RefreshRangesOptions, "dryRun">, usage: UsageAccumulator) {
  return run(args.vaultId, args.store, args.dryRun, "ingest:refresh-ranges", async (client) => {
    await refreshRangesFor(client, { ...ranges, dryRun: args.dryRun }, args.mode, usage);
  });
}

export async function opRefreshMarkerGroups(args: OpArgs, usage: UsageAccumulator) {
  return run(args.vaultId, args.store, args.dryRun, "ingest:refresh-marker-groups", async (client) => {
    await refreshMarkerGroupsFor(client, args.force, args.mode, usage, args.dryRun);
  });
}

export async function opSyncTreatmentAttachments(args: OpArgs, name?: string) {
  return run(args.vaultId, args.store, args.dryRun, "ingest:sync-treatment-attachments", (client) =>
    reconcileTreatmentAttachments(client, name),
  );
}

export interface PendingResult {
  processed: string[]; // pending ids folded in
  stillPending: string[]; // pending ids that failed again (parse error, no readings)
  failures: { id: string; message: string }[];
}

// Mirrors src/lib/import-flow.ts's classifyUpload dispatch (browser-only there: DOM File +
// fetch-based extraction) against a pending upload's raw bytes already sitting in R2, using the
// same foldReport/foldSource the browser and the old CLI both fold through.
async function processOnePending(
  client: Client,
  clientId: string,
  store: string,
  pending: PendingUpload,
  mode: InferenceMode,
  usage: UsageAccumulator,
): Promise<{ client: Client; ok: true } | { ok: false; message: string }> {
  const rawKey = r2RawKeyFor(store, clientId, pending.file);
  const bytes = await getObject(LIVE_BUCKET, rawKey);
  if (!bytes) return { ok: false, message: `raw object missing at ${LIVE_BUCKET}/${rawKey}` };

  const importedAt = new Date().toISOString();
  if (/\.pdf$/i.test(pending.originalName)) {
    try {
      const { extractReportText } = await import("@pablotech/akesi/pdf-node");
      const text = await extractReportText(bytes);
      const report = await proposeFromReport(text, pending.originalName, client, importedAt.slice(0, 10), undefined, mode, usage);
      const fold = foldReport(client, clientId, pending.sha256, pending.id, report, pending.originalName, importedAt);
      dropPending(fold.client, pending.sha256);
      return { client: fold.client, ok: true };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  const ext = pending.originalName.toLowerCase().split(".").pop();
  try {
    const parsed = await parseRawFile(bytes, ext);
    if (!parsed.rows.length) throw new Error("no readings");
    const srcFold = foldSource(client, clientId, pending.sha256, pending.id, parsed, ext ?? "", pending.originalName, importedAt);
    dropPending(srcFold.client, pending.sha256);
    return { client: srcFold.client, ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

function dropPending(client: Client, sha256: string): void {
  if (!client.pendingUploads) return;
  client.pendingUploads = client.pendingUploads.filter((p) => p.sha256 !== sha256);
}

async function foldAllPending(client: Client, clientId: string, store: string, mode: InferenceMode, usage: UsageAccumulator): Promise<{ client: Client; result: PendingResult }> {
  let current = client;
  const result: PendingResult = { processed: [], stillPending: [], failures: [] };
  for (const pending of [...(client.pendingUploads ?? [])]) {
    const outcome = await processOnePending(current, clientId, store, pending, mode, usage);
    if (outcome.ok) {
      current = outcome.client;
      result.processed.push(pending.id);
    } else {
      result.stillPending.push(pending.id);
      result.failures.push({ id: pending.id, message: outcome.message });
    }
  }
  return { client: current, result };
}

export async function opProcessPending(args: OpArgs, usage: UsageAccumulator) {
  return run(args.vaultId, args.store, args.dryRun, "ingest:process-pending", async (client, vault, clientKey) => {
    const { client: next, result } = await foldAllPending(client, args.vaultId, args.store, args.mode, usage);
    vault.clients[clientKey] = next;
    return result;
  });
}

export interface ReconcileResult {
  clients: { vaultId: string; result: PendingResult }[];
}

// "Omit --client for all" (ingest-args.ts's documented --reconcile contract) is the one real
// difference left once there's no plaintext mirror to hydrate — reconcile is process-pending,
// optionally fanned out across every deployed vault in this store.
export type ReconcileArgs = Omit<OpArgs, "vaultId"> & { vaultId?: string };

export async function opReconcile(args: ReconcileArgs, usage: UsageAccumulator): Promise<ReconcileResult> {
  const ids = args.vaultId ? [args.vaultId] : await listDeployedVaultIds(args.store);
  const clients: ReconcileResult["clients"] = [];
  for (const id of ids) {
    const out = await opProcessPending({ ...args, vaultId: id }, usage);
    clients.push({ vaultId: id, result: out.value });
  }
  return { clients };
}

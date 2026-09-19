// The six ops ops.yml could no longer dispatch once records/private/ stayed behind in
// plover-code (refresh-finding, refresh-ranges, refresh-marker-groups,
// sync-treatment-attachments, process-pending, reconcile) — reimplemented here against R2/D1
// directly, with zero dependency on a local plaintext vault mirror. Each is a thin composition of
// vault-ops.ts's pull/mutate/push cycle around logic this repo already has and the browser/Pages
// Functions path already exercises: refresh.ts's three regen functions, factors.ts's treatment-
// attachment reconciliation, and import-flow.ts's report/source fold functions.
//
// treatment-groups-backfill and treatment-photo-extract joined the same way later — both were
// one-off plover-code CLI scripts against the local plaintext mirror, now reimplemented against
// R2/D1 directly below.

import type { Client, InferenceMode, PendingUpload, TreatmentItem } from "../../src/lib/types";
import { UsageAccumulator } from "../inference-cost";
import { recordOrgKeyUse } from "../access-log";
import { getObject, r2RawKeyFor, LIVE_BUCKET } from "../vault-sync";
import { withDeployedClient, listDeployedVaultIds } from "../vault-ops";
import { refreshFindingFor, refreshRangesFor, refreshMarkerGroupsFor, type RefreshRangesOptions } from "./refresh";
import { reconcileTreatmentAttachments, nodeHashesOf } from "../factors";
import { foldReport, foldSource } from "../../src/lib/import-flow";
import { proposeFromReport } from "../claude-report";
import { parseRawFile } from "../../src/lib/parse-raw";
import { staleNodes } from "../../src/lib/staleness";
import { leafContextFor, mergeLeafResult } from "../../src/lib/leaf-regen-registry";
import { runLeafRegen } from "../../src/lib/leaf-regen-anthropic";
import { modelFor } from "../../functions/_lib/inference/resolve";
import { TREATMENT_INFER_MAX_TOKENS } from "../../src/lib/treatment-infer-config";
import { inferTreatment, type ProposedTreatment } from "@pablotech/akesi/treatment-infer";
import { administrationUnitChanged } from "@pablotech/akesi/treatment-product";

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

// Reconcile is process-pending, fanned out across every deployed vault when --client is omitted.
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

// Same six DAG leaf nodes leaf-regen-queue.svelte.ts's browser-side background sweep watches
// (src/lib/leaf-regen-queue.svelte.ts:25-32) — duplicated rather than imported because that file
// pulls in Svelte runes and the browser fetch-based leaf-regen-client.ts, neither of which belongs
// in a Node CLI script.
const SWEEPABLE_LEAF_NODES = [
  "treatmentGroups",
  "hypothesisEvaluation",
  "aiOnPlan",
  "treatmentAssessment",
  "studyResults",
  "noteResults",
] as const;

export function staleLeafNodes(stale: ReadonlySet<string>): string[] {
  return SWEEPABLE_LEAF_NODES.filter((node) => stale.has(node));
}

// Continue-on-failure per node, unlike refresh.ts's runLeaf (which throws and lets its caller
// abort the whole regen): a backfill sweep must keep nodes already filled earlier in the same run
// rather than losing them to one bad node's uncaught throw.
async function regenerateLeaf(client: Client, node: string, usage: UsageAccumulator): Promise<void> {
  const llm = modelFor(process.env, "leafRegen");
  const result = await runLeafRegen({ ...llm, node, inputs: leafContextFor(node, client) });
  if (result.kind === "empty") return;
  usage.record(llm.model, { input_tokens: result.usage.input, output_tokens: result.usage.output });
  if (result.kind !== "ok") throw new Error(`${node}: ${result.kind}`);
  const next = mergeLeafResult(client, node, result.result);
  Object.assign(client, next);
  // mergeLeafResult stamps finding.basis/promptVersions but not nodeHashes — without this, staleNodes()
  // would still flag the node we just backfilled, causing a redundant re-run on the very next sweep.
  client.finding!.nodeHashes = { ...client.finding!.nodeHashes, [node]: nodeHashesOf(client)[node] };
}

export interface BackfillResult {
  nodes: string[]; // regenerated (real run) or stale-and-would-regenerate (dry run) leaf nodes
  failures: { node: string; message: string }[];
}

export async function opTreatmentGroupsBackfill(args: OpArgs, usage: UsageAccumulator) {
  return run(args.vaultId, args.store, args.dryRun, "ingest:treatment-groups-backfill", async (client) => {
    if (!client.finding) throw new Error(`${args.vaultId}: no Finding yet — run --refresh-finding first.`);
    const nodes = staleLeafNodes(await staleNodes(client));
    const result: BackfillResult = { nodes: [], failures: [] };
    if (args.dryRun) {
      result.nodes = nodes;
      return result;
    }
    for (const node of nodes) {
      try {
        await regenerateLeaf(client, node, usage);
        result.nodes.push(node);
      } catch (e) {
        result.failures.push({ node, message: (e as Error).message });
      }
    }
    return result;
  });
}

export function selectTreatmentRows(treatments: TreatmentItem[], name: string, rowId?: string): TreatmentItem[] {
  const target = name.trim().toLowerCase();
  const byName = treatments.filter((t) => t.name.trim().toLowerCase() === target);
  return rowId ? byName.filter((t) => t.id === rowId) : byName;
}

// The old CLI script's exact medicine-scope patch: every dose row sharing the treatment's name
// gets the same label facts, and doseUnit only relabels when the extraction's administration unit
// actually changed — the one thing that unlocks computeConclusion's Daily total for a legacy row.
// Deliberately NOT reused from treatment-infer-merge.ts/treatment-medicine-fanout.ts: both assume a
// full-form replace (overwrite name/kind, unconditionally relabel doseUnit, null out images) that
// would clobber fields this narrower photo-only patch never touches.
export function applyPhotoExtractPatch(
  rows: TreatmentItem[],
  proposed: ProposedTreatment,
  now: () => string = () => new Date().toISOString(),
): void {
  const relabelUnit = administrationUnitChanged(rows[0].administration, proposed.administration)
    ? proposed.administration!.unit
    : null;
  const extractedAt = now();
  for (const row of rows) {
    row.description = proposed.description;
    row.maker = proposed.maker;
    row.ingredients = proposed.ingredients ? [...proposed.ingredients] : undefined;
    row.links = proposed.links ? [...proposed.links] : undefined;
    row.administration = proposed.administration ? { ...proposed.administration } : undefined;
    row.extracted = { via: "photo", at: extractedAt };
    row.rawCaptureAttachmentKeys = (row.attachments ?? []).map((a) => a.key);
    if (relabelUnit != null) row.doseUnit = relabelUnit;
  }
}

// Duplicated rather than imported from src/lib/extract-client.ts (document-read-check.ts does the
// same): that module also POSTs to a relative API path via the browser fetch API, and
// cli-import-graph.test.ts forbids any CLI script's import graph from reaching that transport.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return Buffer.from(binary, "binary").toString("base64");
}

export interface PhotoExtractArgs {
  name: string;
  rowId?: string;
  keys: string[];
}

export interface PhotoExtractResult {
  rowIds: string[];
  // Absent under --dry-run: ops.yml's preview contract is "no Anthropic call," so there is nothing
  // to preview here beyond which rows a real run would touch.
  proposed?: ProposedTreatment;
}

export async function opTreatmentPhotoExtract(args: OpArgs, extract: PhotoExtractArgs, usage: UsageAccumulator) {
  return run(args.vaultId, args.store, args.dryRun, "ingest:treatment-photo-extract", async (client) => {
    const rows = selectTreatmentRows(client.factors?.treatments ?? [], extract.name, extract.rowId);
    if (rows.length === 0) {
      throw new Error(
        `${args.vaultId}: no treatment rows named "${extract.name}"${extract.rowId ? ` with id "${extract.rowId}"` : ""}`,
      );
    }
    const rowIds = rows.map((r) => r.id);
    if (args.dryRun) return { rowIds };

    const { client: anthropic, model } = modelFor(process.env, "treatmentImage");
    const images = await Promise.all(
      extract.keys.map(async (key) => {
        const rawKey = r2RawKeyFor(args.store, args.vaultId, key);
        const bytes = await getObject(LIVE_BUCKET, rawKey);
        if (!bytes) throw new Error(`raw object missing at ${LIVE_BUCKET}/${rawKey}`);
        const mediaType = key.toLowerCase().endsWith(".png") ? ("image/png" as const) : ("image/jpeg" as const);
        return { base64: bytesToBase64(bytes), mediaType };
      }),
    );

    const proposed = await inferTreatment(anthropic, { images }, model, TREATMENT_INFER_MAX_TOKENS, usage);
    applyPhotoExtractPatch(rows, proposed);
    return { rowIds, proposed };
  });
}

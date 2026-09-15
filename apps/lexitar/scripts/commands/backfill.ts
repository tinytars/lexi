// The four backfills, and the guard that stops any of them overwriting live data.
//
// W68 — lifted out of ingest.ts. Both CLI defects W67 found lived in here, and both were the same
// shape: a predicate asking a different question from the one the command answers. They went
// unnoticed because this sat in the middle of 1774 lines holding ten unrelated programs. A predicate
// next to the thing it is about can at least be read.

import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { decryptVault } from "@tinytars/vault/crypto";
import type { Client, Vault } from "../../src/lib/types";
import { assessmentFor, bucketOf, todayISODate, treatmentLabel } from "@pablotech/akesi/treatment-bucket";
import { treatmentsOf } from "@pablotech/akesi/treatment-normalize";
import { populatedNoteEntries } from "@pablotech/akesi/finding-generate";
import { labelSubject, leafContextFor, mergeLeafResult } from "../../src/lib/leaf-regen-registry";
import { runLeafRegen } from "../../src/lib/leaf-regen-anthropic";
import { REGROUP_MODEL } from "../../src/lib/regroup-config";
import type { UsageAccumulator } from "../inference-cost";
import { orgSidecarFromD1 } from "../org-d1";
import { clientPassOf, loadClientVault, persistClientVault } from "../vault-io";
import { isV2, openV2 } from "../vault-v2";
import { pull as pullVault, pullVaultTo, push as pushVault, resolveStore } from "../vault-sync";

// Fills any Ongoing/Past treatment missing a finding.treatment assessment, and any Planned
// treatment missing a finding.planAssessmentRows entry — the same gap the UI's own "regenerate the
// Translation" empty state reports (UnifiedTreatment.svelte), just swept across a client (or every
// client) at once instead of waiting for someone to open each row's Edit modal or click the new
// Translate menu item. Uses matchOngoingAssessment (the exact matcher the UI uses to decide "is
// this missing") and LEAF_REGEN_SPECS/runLeafRegen (the exact node specs + Anthropic-calling core
// /api/leaf-regen uses) — so "missing" and "regenerated" never mean something different here than
// they do in the app.
// `force` regenerates every treatment rather than only those with no assessment yet. Needed whenever
// a prompt changes: the stored answers are not missing, they are stale, and "fill the missing" leaves
// a wrong assessment in place forever. Pairs with mergeLabeledItems' subjectOf — a re-answer whose
// dose label drifted supersedes the old entry instead of piling up beside it.
// The deployed vault is the source of truth (repo CLAUDE.md). pullVault() refreshes only the .enc,
// while loadClientVault() reads the PLAINTEXT repo snapshot — so persist+push here uploads the
// snapshot over the live vault. When the two have diverged that silently destroys whatever users
// entered through the app since the snapshot was taken. Refuse rather than guess: regenerate through
// the deployed app's own Translate instead, or reconcile the snapshot first.
export async function assertRepoMatchesR2(id: string, store = resolveStore()): Promise<void> {
  const tmp = resolve(tmpdir(), `hd-guard-${id.toLowerCase()}.enc`);
  const pulled = await pullVaultTo(id, tmp, store);
  if (pulled === "missing") return; // nothing deployed yet — the repo is the only copy.
  const blob = new Uint8Array(await readFile(tmp));
  const live = isV2(blob)
    ? await openV2<Vault>(blob, orgSidecarFromD1(id.toLowerCase()))
    : await decryptVault<Vault>(blob, clientPassOf(id));
  await rm(tmp, { force: true });
  const repo = (await loadClientVault(id)).clients[id];
  const deployed = live.clients[id];
  if (!deployed) return;
  const counts = (c: Client | undefined) => ({
    treatments: treatmentsOf(c ?? ({} as Client)).length,
    assessments: (c?.finding?.treatment ?? []).length,
    results: (c?.results ?? []).length,
  });
  const a = counts(repo);
  const b = counts(deployed);
  if (a.treatments !== b.treatments || a.assessments !== b.assessments || a.results !== b.results) {
    throw new Error(
      `${id}: the repo snapshot and the DEPLOYED vault disagree — refusing to push and destroy live data.\n` +
      `  repo:     ${a.treatments} treatments, ${a.assessments} assessments, ${a.results} results\n` +
      `  deployed: ${b.treatments} treatments, ${b.assessments} assessments, ${b.results} results\n` +
      `  The deployed vault is the source of truth. Regenerate through the app's Translate, or\n` +
      `  reconcile this snapshot first (--reconcile), then re-run.`,
    );
  }
}

/**
 * Planned actions with no row in planAssessmentRows — the section aiOnPlan actually writes, compared
 * the dose-insensitive way aiOnPlan itself compares (the plan carries "Tirzepatide 9mg/week"; the leaf
 * answers "Tirzepatide"). Shared by the treatment backfill's trigger and the aiOnPlan spec below so
 * the two can never disagree about whether a regen is needed.
 */
export function unassessedPlanActions(client: Client): string[] {
  const assessed = new Set((client.finding?.planAssessmentRows ?? []).map((r) => labelSubject(r.action.trim())));
  return treatmentsOf(client)
    .filter((t) => bucketOf(t, todayISODate()) === "planned")
    .map((t) => treatmentLabel(t))
    .filter((label) => !assessed.has(labelSubject(label)));
}

// W68 one-time cleanup — drop Finding entries whose source row is gone. Deleting a row now takes its
// AI turn with it (vault-item-ops.ts pruneFindingFor), but nothing ever pruned before, so any vault
// touched before that carries orphans: found on the live vault as two treatment assessments for drugs
// deleted months ago. Reports what it removed rather than working silently — this deletes generated
// clinical prose, and the operator should see which.
export function pruneFindingOrphans(client: Client): void {
  const f = client.finding;
  if (!f) return;
  const removed: string[] = [];

  const byId = [
    ["noteResults", "noteId", (populatedNoteEntries(client) ?? []).map((n) => n.id)],
    ["allergyResults", "allergyId", (client.factors?.allergies ?? []).map((a) => a.id)],
    ["familyResults", "familyId", (client.factors?.familyHistory ?? []).map((a) => a.id)],
    ["diseaseResults", "diseaseId", (client.factors?.diseases ?? []).map((d) => d.id)],
  ] as const;
  for (const [section, idField, liveIds] of byId) {
    const rows = f[section] as Record<string, string>[] | undefined;
    if (!rows) continue;
    const live = new Set(liveIds);
    const kept = rows.filter((r) => live.has(r[idField]));
    if (kept.length !== rows.length) {
      removed.push(`${section}: ${rows.length - kept.length}`);
      (f as unknown as Record<string, unknown>)[section] = kept;
    }
  }

  const liveSubjects = new Set(treatmentsOf(client).map((t) => labelSubject(t.name)));
  const keptTreatment = (f.treatment ?? []).filter((e) => liveSubjects.has(labelSubject(e.item)));
  if (keptTreatment.length !== (f.treatment ?? []).length) {
    for (const e of f.treatment ?? []) if (!liveSubjects.has(labelSubject(e.item))) removed.push(`treatment "${e.item}"`);
    f.treatment = keptTreatment;
  }
  process.stdout.write(removed.length ? `  pruned orphans — ${removed.join(", ")}\n` : "  no Finding orphans.\n");
}

// noteResults/familyResults/allergyResults are all the same shape: unscoped (no targetLabels — see
// each leaf-regen spec's comment), paired to the source array by id, "missing" meaning no entry in
// the finding array for a populated item's id. One generic backfill covers all three instead of
// tripling backfillTreatmentAssessmentForClient's shape for a simpler case.

export interface UnscopedBackfillNode {
  node: string;
  // The populated source items' ids. Used only to decide whether anything is missing a result —
  // W67 made the model echo each row's id, so the merge no longer depends on this order.
  ids: (client: Client) => string[];
  hasResult: (client: Client, id: string) => boolean;
}

export const UNSCOPED_BACKFILL_NODES: Record<"noteResults" | "familyResults" | "allergyResults" | "aiOnPlan", UnscopedBackfillNode> = {
  // Not id-keyed like the other three, but the same shape works: "is anything missing" drives the
  // call, and aiOnPlan's merge REPLACES planAssessmentRows wholesale — so one unscoped run fixes both
  // a missing assessment AND a stale row still assessing an action that left the plan.
  aiOnPlan: {
    node: "aiOnPlan",
    ids: (c) => treatmentsOf(c).filter((t) => bucketOf(t, todayISODate()) === "planned").map((t) => treatmentLabel(t)),
    hasResult: (c, label) => !unassessedPlanActions(c).includes(label),
  },
  noteResults: {
    node: "noteResults",
    ids: (c) => populatedNoteEntries(c).map((n) => n.id),
    hasResult: (c, id) => (c.finding?.noteResults ?? []).some((r) => r.noteId === id),
  },
  familyResults: {
    node: "familyResults",
    ids: (c) => (c.factors?.familyHistory ?? []).map((f) => f.id),
    hasResult: (c, id) => (c.finding?.familyResults ?? []).some((r) => r.familyId === id),
  },
  allergyResults: {
    node: "allergyResults",
    ids: (c) => (c.factors?.allergies ?? []).map((a) => a.id),
    hasResult: (c, id) => (c.finding?.allergyResults ?? []).some((r) => r.allergyId === id),
  },
};

export async function backfillTreatmentAssessmentForClient(
  id: string,
  usage: UsageAccumulator,
  dryRun: boolean,
  noSync: boolean,
  force = false,
): Promise<{ filledAssessment: number; filledPlan: boolean }> {
  if (!noSync) {
    await pullVault(id);
    // Before spending anything: if the snapshot has drifted from the deployed vault, this run could
    // only end by overwriting live data, so stop now rather than after a bill.
    await assertRepoMatchesR2(id);
  }
  let client = (await loadClientVault(id)).clients[id];
  if (!client?.finding) {
    process.stdout.write(`  ${id}: no Finding yet — skipping (run --refresh-finding first).\n`);
    return { filledAssessment: 0, filledPlan: false };
  }

  const today = todayISODate();
  const treatments = treatmentsOf(client);
  const missingNames = [...new Set(
    treatments
      .filter((t) => bucketOf(t, today) !== "planned")
      // assessmentFor, per phase — this used to call matchOngoingAssessment for ongoing/past and,
      // just below, an EXACT Set of action labels for planned: the same strict-lookup bug as the
      // card, here making the backfill judge an assessment missing and burn a regen replacing it.
      .filter((t) => force || !assessmentFor(client!.finding, t.name, bucketOf(t, today)))
      .map((t) => t.name.trim())
      .filter(Boolean),
  )];
  const plannedRows = treatments.filter((t) => bucketOf(t, today) === "planned");
  // W67 — this used to ask assessmentFor(finding, name, "planned"), which reads finding.treatment[].
  // aiOnPlan writes planAssessmentRows. Checking a different section than the one it fills is why a
  // patient with complete treatment[] phases but a gap in planAssessmentRows read as "nothing to do"
  // — found by running finding-invariants.ts against the live vaults.
  const missingPlanned = force ? plannedRows.length > 0 : unassessedPlanActions(client!).length > 0;

  if (missingNames.length === 0 && !missingPlanned) return { filledAssessment: 0, filledPlan: false };

  if (dryRun) {
    process.stdout.write(
      `  ${id}: would fill treatmentAssessment for [${missingNames.join(", ")}]` +
      `${missingPlanned ? " + aiOnPlan" : ""}.\n`,
    );
    return { filledAssessment: missingNames.length, filledPlan: missingPlanned };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Required to backfill treatment translations.");

  let changed = false;
  if (missingNames.length > 0) {
    const outcome = await runLeafRegen({
      apiKey, node: "treatmentAssessment", inputs: leafContextFor("treatmentAssessment", client), targetLabels: missingNames,
    });
    if (outcome.kind !== "empty") usage.record(REGROUP_MODEL, { input_tokens: outcome.usage.input, output_tokens: outcome.usage.output });
    if (outcome.kind === "ok") {
      client = mergeLeafResult(client, "treatmentAssessment", outcome.result);
      changed = true;
      process.stdout.write(`  ${id}: filled treatmentAssessment for ${missingNames.length} treatment(s).\n`);
    } else if (outcome.kind !== "empty") {
      process.stdout.write(`  ${id}: treatmentAssessment regen failed (${outcome.kind}) — left as-is.\n`);
    }
  }

  if (missingPlanned) {
    const outcome = await runLeafRegen({ apiKey, node: "aiOnPlan", inputs: leafContextFor("aiOnPlan", client) });
    if (outcome.kind !== "empty") usage.record(REGROUP_MODEL, { input_tokens: outcome.usage.input, output_tokens: outcome.usage.output });
    if (outcome.kind === "ok") {
      client = mergeLeafResult(client, "aiOnPlan", outcome.result);
      changed = true;
      process.stdout.write(`  ${id}: filled aiOnPlan.\n`);
    } else if (outcome.kind !== "empty") {
      process.stdout.write(`  ${id}: aiOnPlan regen failed (${outcome.kind}) — left as-is.\n`);
    }
  }

  if (changed) {
    if (!noSync) await assertRepoMatchesR2(id);
    const vault = await loadClientVault(id);
    vault.clients[id] = client;
    await persistClientVault(id, vault);
    if (!noSync) {
      await pushVault(id);
      process.stdout.write(`  ${id}: pushed updated vault to R2.\n`);
    }
  }

  return { filledAssessment: missingNames.length, filledPlan: missingPlanned };
}

export async function backfillUnscopedResultsForClient(
  id: string,
  spec: UnscopedBackfillNode,
  usage: UsageAccumulator,
  dryRun: boolean,
  noSync: boolean,
): Promise<boolean> {
  if (!noSync) await pullVault(id);
  let client = (await loadClientVault(id)).clients[id];
  if (!client?.finding) {
    process.stdout.write(`  ${id}: no Finding yet — skipping (run --refresh-finding first).\n`);
    return false;
  }

  const missing = spec.ids(client).some((itemId) => !spec.hasResult(client!, itemId));
  if (!missing) return false;

  if (dryRun) {
    process.stdout.write(`  ${id}: would fill ${spec.node} (at least one entry missing a result).\n`);
    return true;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Required to backfill translations.");

  const inputs = leafContextFor(spec.node, client);
  const outcome = await runLeafRegen({ apiKey, node: spec.node, inputs });
  if (outcome.kind !== "empty") usage.record(REGROUP_MODEL, { input_tokens: outcome.usage.input, output_tokens: outcome.usage.output });
  if (outcome.kind !== "ok") {
    if (outcome.kind !== "empty") process.stdout.write(`  ${id}: ${spec.node} regen failed (${outcome.kind}) — left as-is.\n`);
    return false;
  }

  client = mergeLeafResult(client, spec.node, outcome.result);
  process.stdout.write(`  ${id}: filled ${spec.node}.\n`);

  if (!noSync) await assertRepoMatchesR2(id);
  const vault = await loadClientVault(id);
  vault.clients[id] = client;
  await persistClientVault(id, vault);
  if (!noSync) {
    await pushVault(id);
    process.stdout.write(`  ${id}: pushed updated vault to R2.\n`);
  }
  return true;
}

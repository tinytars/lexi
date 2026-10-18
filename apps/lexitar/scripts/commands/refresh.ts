// The three regeneration commands: the Finding, personalized Ranges, and marker grouping.
//
// W68 — lifted out of ingest.ts. These are the only CLI commands that spend money, which is reason
// enough for them to be readable in one screen rather than interleaved with argument parsing and
// three one-time migrations.

import type { Client, InferenceMode } from "../../src/lib/types";
import { modelId } from "../../src/lib/model-config";
import { modelFor } from "../../functions/_lib/inference/resolve";
import type { UsageAccumulator } from "../inference-cost";
import { generateFinding } from "../claude-finding";
import { generateRange } from "../claude-ranges";
import { generateMarkerGroups } from "../claude-marker-groups";
import { orchestrateRefresh, leafRegenOrder } from "../../src/lib/finding-refresh";
import { dagNode } from "../../src/lib/finding-dag";
import { leafContextFor, mergeLeafResult } from "../../src/lib/leaf-regen-registry";
import { runLeafRegen } from "../../src/lib/leaf-regen-anthropic";
import { nodeHashesOf, planFindingRefresh } from "../factors";
import { mergeCriticalRatios } from "../../src/lib/marker-ratios";
import { recommendedNamesFromFinding } from "../../src/lib/finding-render";
import { markerGroupsHashOf, distinctMarkerNames } from "@pablotech/akesi/marker-groups-prompt";
import { systemAnalysisEstablished, systemOrder } from "@pablotech/akesi/system-groups";

// The ONE way the CLI regenerates a leaf, used by both the selective path and the full refresh's
// orchestrator. Runs on the "leafRegen" feature (the leaf tier) — the same model, prompt, tool schema and
// validation the browser's Translate button and /api/leaf-regen use, so a section cannot come back
// two different ways depending on which entry point asked for it.
export async function runLeaf(c: Client, node: string, usage: UsageAccumulator): Promise<Client> {
  const llm = modelFor(process.env, "leafRegen");
  const result = await runLeafRegen({ ...llm, node, inputs: leafContextFor(node, c) });
  if (result.kind === "empty") return c;
  // Billed at the leaf tier, not the core's — attributing these to the core's model overstated
  // a refresh's cost fivefold, since Opus output is $75/M against Sonnet's $15/M.
  usage.record(llm.model, { input_tokens: result.usage.input, output_tokens: result.usage.output });
  if (result.kind !== "ok") throw new Error(`${node}: ${result.kind}`);
  return mergeLeafResult(c, node, result.result);
}

export async function refreshFindingFor(client: Client, force: boolean, mode: InferenceMode, usage: UsageAccumulator, dryRun = false): Promise<void> {
  // W15d — per-node staleness decides the cheapest correct refresh: skip, regen only the stale
  // leaves (a fraction of the cost), note lagging summaries, or fall back to the full core regen.
  const plan = planFindingRefresh(client, force);
  // W77 — one meaning for --dry-run across every command that spends money: no Anthropic call, no
  // write. The plan is the whole answer here, because it is what decides whether the next minutes
  // cost a leaf or a full Opus core regen.
  if (dryRun) {
    process.stdout.write(`DRY-RUN refresh-finding: ${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (plan.kind === "up-to-date") {
    process.stdout.write("Finding is up-to-date for current inputs (use --force to regenerate).\n");
    return;
  }
  if (plan.kind === "summaries-lagging") {
    process.stdout.write(
      `Core + leaves are fresh; only whole-report summaries lag (${plan.lagging.join(", ")}). Run with --force to refresh them.\n`,
    );
    return;
  }
  if (plan.kind === "leaf-only" && client.finding) {
    process.stdout.write(
      `Selective refresh — only leaves are stale (${plan.leaves.join(", ")}); skipping the full ${modelId("finding", mode)} core regen.\n`,
    );
    // Dependency order, not the order staleness happened to report them in: a stale pair like
    // diseaseResults + treatmentAssessment must regenerate disease first, or the second reads the
    // previous run's group names. Same ordering the full refresh uses.
    for (const leaf of leafRegenOrder().filter((n) => plan.leaves.includes(n))) {
      process.stdout.write(`  ${dagNode(leaf)?.label ?? leaf} (${modelId("leafRegen")})… `);
      try {
        const next = await runLeaf(client, leaf, usage);
        Object.assign(client, next);
        client.finding!.nodeHashes = { ...client.finding!.nodeHashes, [leaf]: nodeHashesOf(client)[leaf] };
        process.stdout.write("done.\n");
      } catch (e) {
        process.stdout.write("FAILED\n");
        process.stderr.write(`    ${(e as Error).message}\n`);
      }
    }
    if (plan.lagging.length > 0) {
      process.stdout.write(`  note: whole-report summaries (${plan.lagging.join(", ")}) now lag — run --force when you want them refreshed.\n`);
    }
    return;
  }
  if (plan.kind === "full" && plan.reason !== "forced") {
    process.stdout.write(`Full Finding regen (${plan.reason}).\n`);
  }
  // Critical ratios are additive: capture the locked-in set BEFORE regeneration so a
  // re-run can add new ratios but never silently drop existing ones (removal is the
  // explicit --remove-ratio path).
  const priorRatios = client.finding?.criticalRatios ?? [];
  process.stdout.write(`Generating Finding via Claude (${mode}/${modelId("finding", mode)})… `);
  // W65 — core, then every leaf, through the SAME orchestrator the browser button uses. Before this
  // the CLI stopped at the core, so a `--refresh-finding` and a provider's refresh produced
  // different Findings from the same inputs — the exact divergence finding-refresh.ts exists to
  // prevent, and the one the W65 probe measured (8 collapsed drug names here vs 27 dated dose
  // periods there). The leaf runner is runLeafRegen in-process; the browser's is the relay.
  let refreshed: Client;
  try {
    const outcome = await orchestrateRefresh(client, {
      generateCore: async () => {
        const finding = await generateFinding(client, modelId("finding", mode), mode, usage);
        process.stdout.write("done.\n");
        return finding;
      },
      runLeaf: (c, node) => runLeaf(c, node, usage),
      onStage: (st) => { if (st.index > 0) process.stdout.write(`  [${st.index}/${st.total}] ${st.label}… `); },
    });
    refreshed = outcome.client;
    for (const f of outcome.failures) process.stdout.write(`  ${f.label}: FAILED (${f.message}) — retry with its own Translate.\n`);
    if (outcome.failures.length === 0) process.stdout.write("  all leaves done.\n");
    // Distinct from failures: every leaf can succeed on its own terms and still leave the assembled
    // Finding inconsistent. Local stderr only — these messages name treatments and groups.
    for (const v of outcome.invariants) process.stderr.write(`  invariant: ${v}\n`);
  } catch (e) {
    process.stdout.write("FAILED\n");
    process.stderr.write(`  ${(e as Error).message}\n`);
    throw e;
  }
  // orchestrateRefresh returns a NEW Client (the leaf merges are immutable); this function's
  // contract is to mutate the caller's `client`, which the caller then persists.
  Object.assign(client, refreshed);
  if (priorRatios.length > 0 && client.finding) {
    const merged = mergeCriticalRatios(priorRatios, client.finding.criticalRatios ?? []);
    process.stdout.write(`Critical Ratios: ${priorRatios.length} locked kept, ${merged.length - priorRatios.length} new added (remove with --remove-ratio).\n`);
    client.finding.criticalRatios = merged;
  }

  client.recommended = recommendedNamesFromFinding(client.finding);
  // Every tracked marker — watchlist and recommended alike — should carry a
  // personalized range. autoGenerate skips those that already have one or have
  // no lab data, so passing the full tracked set just backfills what's missing.
  const tracked = [...new Set([...client.watchlist, ...client.recommended])];
  await autoGenerateRangesForNewMarkers(client, tracked, mode, usage);
}

/** Only the flags this command reads — narrower than ingest's whole Args, so no import cycle. */
export interface RefreshRangesOptions {
  refreshMarkers: string[];
  allMarkers: boolean;
  force: boolean;
  dryRun: boolean;
}

export async function refreshRangesFor(client: Client, args: RefreshRangesOptions, mode: InferenceMode, usage: UsageAccumulator): Promise<void> {
  // W64 — "has this marker any readings at all?", NOT "does it have a unit". A dimensionless ratio
  // marker legitimately has unit "" (types.ts's CriticalRatio convention), and the old check —
  // `unitByMarker.get(marker)` falsy → skip — dropped it before it ever reached the model. The web
  // path always supported these; the CLI could not produce a range for one at all. The unit itself
  // is no longer computed here: ranges-anthropic.ts derives it from the marker's LATEST reading,
  // where this took whichever row came first in client.results.
  const hasReadings = new Set(client.results.map((r) => r.marker));

  let targets: string[];
  if (args.refreshMarkers.length > 0) {
    targets = args.refreshMarkers;
  } else if (args.allMarkers) {
    targets = [...hasReadings];
  } else {
    const tracked = new Set([...client.watchlist, ...(client.recommended ?? [])]);
    targets = [...tracked].filter((m) => hasReadings.has(m));
  }
  if (targets.length === 0) {
    process.stdout.write("No markers to refresh.\n");
    return;
  }

  client.personalizedRanges ??= {};
  const currentHash = client.factorsHash!;
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;

  const work: { marker: string }[] = [];
  for (const marker of targets) {
    if (!hasReadings.has(marker)) {
      process.stderr.write(`  - ${marker}: no data for this client, skipping.\n`);
      failed++;
      continue;
    }
    const existing = client.personalizedRanges[marker];
    if (!args.force && existing && existing.factorsHash === currentHash) {
      skipped++;
      continue;
    }
    work.push({ marker });
  }

  if (args.dryRun) {
    // Reported AFTER the skip/force filter, so this is the set that would actually be billed —
    // not the set that was asked for.
    process.stdout.write(
      `DRY-RUN refresh-ranges: would generate ${work.length} range(s) on ${modelId("ranges", mode)}` +
        `${work.length ? `: ${work.map((w) => w.marker).join(", ")}` : ""}` +
        ` (${skipped} up-to-date, ${failed} without data).\n`,
    );
    return;
  }

  async function runOne({ marker }: { marker: string }): Promise<void> {
    try {
      const range = await generateRange(marker, "", client, modelId("ranges", mode), mode, usage);
      client.personalizedRanges![marker] = range;
      const lo = range.low ?? "—";
      const hi = range.high ?? "—";
      process.stdout.write(`  · ${marker}… ${lo}–${hi} ${range.unit}\n`);
      refreshed++;
    } catch (e) {
      process.stdout.write(`  · ${marker}… FAILED\n`);
      process.stderr.write(`    ${(e as Error).message}\n`);
      failed++;
    }
  }

  // Run the first call serially so the prompt cache is populated, then fan
  // out the rest in parallel so calls 2..N hit a warm cache.
  if (work.length > 0) {
    await runOne(work[0]);
    if (work.length > 1) await Promise.all(work.slice(1).map(runOne));
  }

  process.stdout.write(
    `Refresh complete: ${refreshed} updated, ${skipped} up-to-date, ${failed} failed.\n`,
  );
}

export async function autoGenerateRangesForNewMarkers(client: Client, newMarkers: string[], mode: InferenceMode, usage: UsageAccumulator): Promise<void> {
  // W64 — readings, not units; see refreshRangesFor above.
  const hasReadings = new Set(client.results.map((r) => r.marker));
  client.personalizedRanges ??= {};

  const work: { marker: string }[] = [];
  for (const marker of newMarkers) {
    if (client.personalizedRanges[marker]) continue;
    if (!hasReadings.has(marker)) {
      process.stdout.write(`  + ${marker}: tracked; no lab data on file yet, range deferred.\n`);
      continue;
    }
    work.push({ marker });
  }
  if (work.length === 0) return;

  process.stdout.write(`Computing personalized ranges for ${work.length} tracked marker(s) missing one…\n`);

  async function runOne({ marker }: { marker: string }): Promise<void> {
    try {
      const range = await generateRange(marker, "", client, modelId("ranges", mode), mode, usage);
      client.personalizedRanges![marker] = range;
      const lo = range.low ?? "—";
      const hi = range.high ?? "—";
      process.stdout.write(`  + ${marker}… ${lo}–${hi} ${range.unit}\n`);
    } catch (e) {
      process.stdout.write(`  + ${marker}… FAILED\n`);
      process.stderr.write(`    ${(e as Error).message}\n`);
    }
  }

  await runOne(work[0]);
  if (work.length > 1) await Promise.all(work.slice(1).map(runOne));
}

export async function refreshMarkerGroupsFor(client: Client, force: boolean, mode: InferenceMode, usage: UsageAccumulator, dryRun = false): Promise<void> {
  // Marker grouping is keyed to the System Analysis (finding.disease[].group), so
  // the Finding must exist first. Regenerating the Finding does NOT auto-run this —
  // run --refresh-finding then --refresh-marker-groups.
  if (!systemAnalysisEstablished(client)) {
    process.stdout.write("No System Analysis yet — run --refresh-finding first; markers group by body system once the Finding exists.\n");
    return;
  }
  const markerNames = distinctMarkerNames(client);
  if (markerNames.length === 0) {
    process.stdout.write("No markers to group.\n");
    return;
  }
  const wantHash = markerGroupsHashOf(markerNames, systemOrder(client));
  if (!force && client.markerGroups && client.markerGroups.markerGroupsHash === wantHash) {
    process.stdout.write("Marker grouping is up-to-date (use --force to regenerate).\n");
    return;
  }
  if (dryRun) {
    process.stdout.write(
      `DRY-RUN refresh-marker-groups: would group ${markerNames.length} marker(s) on ${modelId("markerGroups", mode)}.\n`,
    );
    return;
  }
  process.stdout.write(`Grouping ${markerNames.length} markers by body system via Claude (${mode}/${modelId("markerGroups", mode)})… `);
  try {
    client.markerGroups = await generateMarkerGroups(client, modelId("markerGroups", mode), mode, usage);
    process.stdout.write("done.\n");
    for (const g of client.markerGroups.groups) {
      process.stdout.write(`  · ${g.group}: ${g.markers.join(", ")}\n`);
    }
  } catch (e) {
    process.stdout.write("FAILED\n");
    process.stderr.write(`  ${(e as Error).message}\n`);
    throw e;
  }
}

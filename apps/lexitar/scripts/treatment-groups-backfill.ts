// One-time backfill: force-regen every currently-stale sweepable leaf for a client whose
// finding.nodeHashes predate a treatment-data change large enough to stale it. The "never three
// turns" milestone's Step 5 walkthrough gave 22 of Alex's treatments real administration/
// ingredients data for the first time via the app's own Identify flow. That staled treatmentGroups
// (its patientPlan input folds in productCanonical()) — the original reason this script exists —
// but a later, legitimate step in the same walkthrough (re-extracting the treatments themselves)
// also staled treatmentHistory/patientHypothesis, which cascades into hypothesisEvaluation,
// aiOnPlan, treatmentAssessment, studyResults and noteResults too. Nothing forced a regen for any
// of them, because the code path that now does that automatically (UnifiedTreatment.svelte's save,
// on an administration unit change) never re-ran on those already-completed rows.
//
// Left stale, every e2e spec that opens Alex as a provider fires the unprompted background
// sweep() (leaf-regen-queue.svelte.ts), which is unmocked in most specs — a real Anthropic call
// against the shared wrangler pages dev server on every such test, which is what turned into
// widespread e2e timeouts/workerd crashes across unrelated specs sharing that server.
//
// LEAF_REGEN_NODES here mirrors leaf-regen-queue.svelte.ts's own list — the sweepable set, not
// every LEAF_REGEN_SPECS key (a node whose ancestors need the full core regen can't be fixed from
// a leaf call). Duplicated rather than imported: that file is a .svelte.ts module pulling in
// leaf-regen-client.ts's browser fetch path, which has no place in a Node CLI script. Order matters:
// aiOnPlan's context reads hypothesisEvaluation's own stored output (finding.decisions.patient), so
// hypothesisEvaluation must regenerate first or aiOnPlan would be assessed against a stale
// evaluation. The other four read none of the other five (see finding-dag.ts's `inputs`) and can
// run in any order.
//
// Unlike UNSCOPED_BACKFILL_NODES (commands/backfill.ts), these nodes aren't id-keyed against a
// "missing" check — each is either fresh or stale — so this always force-regenerates whichever of
// the six staleNodes() currently reports, rather than checking for a gap. One-time, guarded the
// same way as dose-backfill.ts/leaf-id-backfill.ts: nothing imports this module, so nothing else
// can run main() as a side effect.
//
// vault:build always runs before the push/commit: the served records/public/*.enc is DERIVED
// from the plaintext, not written by the merges above, so skipping it leaves vault:verify (and the
// app's own decrypt) seeing stale data regardless of what the plaintext now says.
//
//   npx tsx scripts/treatment-groups-backfill.ts --client Alex [--dry-run] [--no-sync]
//   npx tsx scripts/treatment-groups-backfill.ts --client Alex --rebuild-enc-only   # recovery:
//     plaintext already has the fix (e.g. a prior run's vault:build step was missing) — just
//     re-derive and push the .enc, without re-billing Anthropic.
//   npx tsx scripts/treatment-groups-backfill.ts --client Alex --diagnose treatmentAssessment \
//     --target-labels "Fish Oil"
//     Read-only: makes ONE real runLeafRegen call, scoped exactly like the browser's own dose-edit
//     trigger (leafContextFor + targetLabels), and prints the raw outcome. Does not pull, merge,
//     persist, vault:build or push — for comparing the scoped path's model behavior against the
//     unscoped backfill above without risking a write. `--dry-run` prints what it would call,
//     without calling.

import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import "./load-creds";
import { leafContextFor, mergeLeafResult } from "../src/lib/leaf-regen-registry";
import { runLeafRegen } from "../src/lib/leaf-regen-anthropic";
import { REGROUP_MODEL } from "../src/lib/regroup-config";
import { staleNodes } from "../src/lib/staleness";
import { UsageAccumulator } from "./inference-cost";
import { loadClientVault, persistClientVault } from "./vault-io";
import { pull as pullVault, push as pushVault } from "./vault-sync";
import { assertRepoMatchesR2 } from "./commands/backfill";

const LEAF_REGEN_NODES = [
  "hypothesisEvaluation",
  "aiOnPlan",
  "treatmentGroups",
  "treatmentAssessment",
  "studyResults",
  "noteResults",
] as const;

async function main() {
  const args = process.argv.slice(2);
  const clientIdx = args.indexOf("--client");
  const id = clientIdx >= 0 ? args[clientIdx + 1] : undefined;
  const dryRun = args.includes("--dry-run");
  const noSync = args.includes("--no-sync");
  // Recovery path: the plaintext already has the fix (e.g. committed by a prior run of this
  // script whose vault:build step was missing) — just re-derive the served .enc from it and
  // push/commit that, without re-billing Anthropic.
  const rebuildEncOnly = args.includes("--rebuild-enc-only");
  const diagnoseIdx = args.indexOf("--diagnose");
  const diagnoseNode = diagnoseIdx >= 0 ? args[diagnoseIdx + 1] : undefined;
  const targetLabelsIdx = args.indexOf("--target-labels");
  const targetLabelsArg = targetLabelsIdx >= 0 ? args[targetLabelsIdx + 1] : undefined;
  if (!id) {
    throw new Error(
      "usage: --client <id> [--dry-run] [--no-sync] [--rebuild-enc-only] [--diagnose <node> [--target-labels a,b]]",
    );
  }

  // --diagnose never merges, persists, builds or pushes (see below), so it has nothing to
  // reconcile against R2 and must not pull — a stray pull is exactly what left the served
  // .enc ahead of vault.json with no commit tying the two together (see 3b37462).
  if (!noSync && !diagnoseNode) {
    await pullVault(id);
    // Before spending anything: if the snapshot has drifted from the deployed vault, this run
    // could only end by overwriting live data.
    await assertRepoMatchesR2(id);
  }
  let client = (await loadClientVault(id)).clients[id];
  if (!client?.finding) throw new Error(`${id}: no Finding yet — run --refresh-finding first.`);

  if (diagnoseNode) {
    const targetLabels = targetLabelsArg
      ? targetLabelsArg.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    if (dryRun) {
      process.stdout.write(
        `${id}: would diagnose ${diagnoseNode} (targetLabels=${JSON.stringify(targetLabels ?? null)}) — no call made.\n`,
      );
      return;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Required to diagnose.");
    // Mirrors leaf-regen-client.ts's fetchLeafRegen exactly: same context call, same targetLabels
    // threaded through. Nothing below this merges, persists, builds or pushes.
    const outcome = await runLeafRegen({
      apiKey,
      node: diagnoseNode,
      inputs: leafContextFor(diagnoseNode, client, targetLabels),
      targetLabels,
    });
    process.stdout.write(
      `${id}: diagnose ${diagnoseNode} targetLabels=${JSON.stringify(targetLabels ?? null)}\n${JSON.stringify(outcome, null, 2)}\n`,
    );
    return;
  }

  const stale = rebuildEncOnly ? new Set<string>() : await staleNodes(client);
  const nodesToRegen = LEAF_REGEN_NODES.filter((n) => stale.has(n));

  if (dryRun) {
    process.stdout.write(
      rebuildEncOnly
        ? `${id}: would rebuild the served .enc from the current plaintext.\n`
        : nodesToRegen.length > 0
          ? `${id}: would force-regen ${nodesToRegen.join(", ")}.\n`
          : `${id}: nothing stale among ${LEAF_REGEN_NODES.join(", ")} — nothing to do.\n`,
    );
    return;
  }

  if (!rebuildEncOnly) {
    if (nodesToRegen.length === 0) {
      process.stdout.write(`${id}: nothing stale among ${LEAF_REGEN_NODES.join(", ")} — nothing to do.\n`);
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Required to backfill stale leaves.");

    const usage = new UsageAccumulator();
    for (const node of nodesToRegen) {
      const outcome = await runLeafRegen({ apiKey, node, inputs: leafContextFor(node, client) });
      if (outcome.kind !== "empty") {
        usage.record(REGROUP_MODEL, { input_tokens: outcome.usage.input, output_tokens: outcome.usage.output });
      }
      if (outcome.kind === "empty") {
        process.stdout.write(`${id}: ${node} had nothing to regenerate.\n`);
        continue;
      }
      if (outcome.kind !== "ok") {
        process.stdout.write(`${id}: ${node} regen failed (${outcome.kind}) — left as-is.\n`);
        continue;
      }
      try {
        client = mergeLeafResult(client, node, outcome.result);
        process.stdout.write(`${id}: filled ${node}.\n`);
      } catch (e) {
        // mergeInto's deep validation (e.g. treatmentGroups' id-coverage check) runs OUTSIDE
        // runLeafRegen's own retry loop — it never gets the self-correction chance a shape-only
        // `validate` failure does, so a well-formed-but-wrong candidate reaches here uncaught.
        // Treat it like any other regen failure: leave the node as-is and keep the nodes already
        // filled this run, rather than losing them to an uncaught throw two lines below.
        process.stdout.write(`${id}: ${node} failed to merge (${(e as Error).message}) — left as-is.\n`);
      }
    }

    // Re-check right before we write our OWN changes, not after: several Anthropic calls just ran,
    // long enough for something else to have pushed to R2 in the meantime. Checking AFTER
    // persistClientVault instead (the original single-node version's order) compares our own
    // freshly-regenerated counts against the still-old deployed ones and always disagrees once a
    // node changes what assertRepoMatchesR2 counts (treatmentGroups never did; treatmentAssessment
    // does) — a false-positive refusal, not a real drift, discovered the first time this ran against
    // a count-changing node.
    if (!noSync) await assertRepoMatchesR2(id);

    const vault = await loadClientVault(id);
    vault.clients[id] = client;
    await persistClientVault(id, vault);
  } else if (!noSync) {
    await assertRepoMatchesR2(id);
  }

  // The served ciphertext is derived from the plaintext, not from the merges above -- without this,
  // vault:verify (and the app's own decrypt) still see the OLD data no matter what just changed.
  execFileSync("npm", ["run", "vault:build", "--", "--client", id.toLowerCase()], { stdio: "inherit" });

  if (!noSync) {
    await pushVault(id);
    process.stdout.write(`${id}: pushed updated vault to R2.\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`treatment-groups-backfill failed: ${(e as Error).message}\n`); process.exit(1); });
}

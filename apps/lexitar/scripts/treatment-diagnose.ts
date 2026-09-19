// Read-only companion to commands/r2-ops.ts's --treatment-groups-backfill: makes ONE real
// runLeafRegen call, scoped exactly like the browser's own dose-edit trigger (leafContextFor +
// targetLabels), and prints the raw outcome. Never pulls into a mutate cycle, merges, or pushes —
// there is nothing here for withDeployedClient's write path to guard, so this stays its own
// script rather than a ninth r2-ops-cli.ts op. Not in ops.yml either, per the "read-only
// inspection stays local" convention (doctor, vault:verify) — this is debugging, not an operation.
//
//   npx tsx scripts/treatment-diagnose.ts --client Pablo --node treatmentAssessment \
//     [--target-labels "Fish Oil,Vitamin D"] [--dry-run]
import "./load-creds";
import { leafContextFor } from "../src/lib/leaf-regen-registry";
import { runLeafRegen } from "../src/lib/leaf-regen-anthropic";
import { pullDeployedVault } from "./vault-ops";
import { resolveStore } from "./vault-sync";
import { isMain } from "./is-main";

export function parseTargetLabels(arg: string | undefined): string[] | undefined {
  if (!arg) return undefined;
  const labels = arg.split(",").map((s) => s.trim()).filter(Boolean);
  return labels.length ? labels : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const id = at("--client");
  const node = at("--node");
  const dryRun = argv.includes("--dry-run");
  const targetLabels = parseTargetLabels(at("--target-labels"));
  if (!id || !node) {
    throw new Error("usage: --client <id> --node <leaf> [--target-labels a,b] [--dry-run]");
  }

  const store = resolveStore();
  const { client } = await pullDeployedVault(id, store);
  if (!client?.finding) throw new Error(`${id}: no Finding yet — run --refresh-finding first.`);

  if (dryRun) {
    process.stdout.write(`${id}: would diagnose ${node} (targetLabels=${JSON.stringify(targetLabels ?? null)}) — no call made.\n`);
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Required to diagnose.");
  const outcome = await runLeafRegen({ apiKey, node, inputs: leafContextFor(node, client, targetLabels), targetLabels });
  process.stdout.write(`${id}: diagnose ${node} targetLabels=${JSON.stringify(targetLabels ?? null)}\n${JSON.stringify(outcome, null, 2)}\n`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`treatment-diagnose failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}

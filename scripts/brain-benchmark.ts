// The host side of the retry-correction benchmark: the loop that joins the two brain packages, and
// nothing else.
//
// The cases, both correction strategies, the retry loop and the scorer all live in
// brain/akesi-pil/benchmarks/retry-corrections.ts, tested offline there. What stays here is the
// compareBrains() call, the Anthropic instance and the model choice — because brain/ARCHITECTURE.md
// is explicit that neither package imports the other and a host application is what joins them.
// This file is that host, and it is deliberately short enough to read in one screen;
// brain/BENCHMARKS.md quotes the joining lines in full so a reader of the public repo sees the seam.
//
// Two regimes, reported separately and never averaged together. A discipline that exists to catch
// failures tells you nothing in a regime where nothing fails, so `failure` deliberately runs the
// weakest available model: it measures the STRATEGY, not production quality. `production` runs what
// health-dash actually uses for Ranges, and answers a different question — whether the strategy
// still matters where it ships.
//
// Run locally (not via ops.yml): writes nothing — no vault, no R2, no D1, no commit — so it falls
// outside the "operations that write get an ops.yml entry" line that CLAUDE.md draws.
//
//   npx tsx scripts/brain-benchmark.ts --preview            # cost and pre-registration, no calls
//   npx tsx scripts/brain-benchmark.ts --regime failure     # or production, or both (default)
import "./load-creds";
import { appendFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { compareBrains } from "@pablotech/neuro-pil/compare";
import {
  CASES,
  CENSORED,
  MAX_ATTEMPTS,
  VERSIONS,
  minimumDetectableWins,
  runCase,
  score,
  signTest,
  wilson,
  withReplicates,
  type RetryOutcome,
} from "@pablotech/akesi-pil/benchmarks/retry-corrections";
import { MODELS, WEAKEST_MODEL } from "./inference-config";

const REGIMES = {
  // The weakest model available, chosen so the validators fire often enough to resolve anything.
  failure: { model: WEAKEST_MODEL, replicates: 2 },
  // What Ranges actually runs on. Small n: this is external validity, not the primary measurement.
  production: { model: MODELS.dev.ranges, replicates: 1 },
} as const;

type RegimeName = keyof typeof REGIMES;

function report(name: RegimeName, versions: { version: { label: string }; scores: number[] }[]): string {
  const [a, b] = versions;
  const pairs = a.scores.map((x, i) => [x, b.scores[i]] as const);
  const discordant = pairs.filter(([x, y]) => x !== y);
  const wins = discordant.filter(([x, y]) => x < y).length;
  const lines = [
    `### ${name} — ${REGIMES[name].model}, n=${a.scores.length}`,
    "",
    "| strategy | mean attempts | valid within 3 | 95% CI | scores |",
    "|---|---|---|---|---|",
    ...versions.map((v) => {
      const ok = v.scores.filter((s) => s < CENSORED).length;
      const [lo, hi] = wilson(ok, v.scores.length);
      const ci = `[${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
      return `| ${v.version.label} | ${(v.scores.reduce((x, y) => x + y, 0) / v.scores.length).toFixed(2)} | ${ok}/${v.scores.length} | ${ci} | ${v.scores.join(", ")} |`;
    }),
    "",
    `Paired: ${discordant.length} discordant of ${pairs.length}; accumulate won ${wins}. ` +
      `Sign test p=${signTest(wins, discordant.length).toFixed(3)}. ` +
      `Pre-registered minimum detectable: ${minimumDetectableWins(discordant.length)} wins of ${discordant.length}.`,
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--regime");
  const names = (flag === -1 ? ["failure", "production"] : [process.argv[flag + 1]]) as RegimeName[];

  if (process.argv.includes("--preview")) {
    for (const name of names) {
      const n = CASES.length * REGIMES[name].replicates;
      process.stdout.write(
        `${name}: model=${REGIMES[name].model}, ${n} cases × ${VERSIONS.length} strategies × up to ` +
          `${MAX_ATTEMPTS} attempts = at most ${n * VERSIONS.length * MAX_ATTEMPTS} calls. ` +
          `Best case — every pair discordant — needs ${minimumDetectableWins(n)} wins of ${n} for p<0.05; ` +
          `every tie costs power, so the real threshold can only be harder.\n`,
      );
    }
    process.stdout.write(`no call made. For the prompts and both suffixes: cd ../../brain/akesi-pil && npm run bench:retry\n`);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
  const anthropic = new Anthropic();

  for (const name of names) {
    const { model, replicates } = REGIMES[name];
    const cases = withReplicates(CASES, replicates);
    const result = await compareBrains<(typeof cases)[number], (typeof VERSIONS)[number], RetryOutcome>(
      cases,
      VERSIONS,
      (c, v) => runCase(anthropic, model, c, v),
      score,
    );
    const table = report(name, result.perVersion);
    process.stdout.write(`${table}\n\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n## brain-benchmark — retry corrections\n\n${table}\n`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

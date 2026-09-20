// The host side of the model-portability benchmark: which inference config to measure, which
// fixtures each feature runs on, and how the result is printed. The harness itself — the probes,
// the retry accounting, the buckets, the statistics — is @pablotech/akesi/benchmarks/model-portability,
// tested offline there and again here (tests/unit/model-bench.test.ts) before anything is billed.
//
// A candidate model is measured by pointing this at a config file, because that is exactly how a
// candidate model is DEPLOYED (INFERENCE.md). Nothing below names a vendor, a model or an endpoint.
//
//   npm run bench:models -- --preview                              # budget + pre-registration, no calls
//   npm run bench:models -- --config inference.examples/open-local.json
//   npm run bench:models -- --feature extract,document
//
// Results belong in MEASUREMENT.md and nowhere else. Writes nothing: no vault, no R2, no D1.
import "./load-creds";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  budget,
  documentProbe,
  extractProbe,
  findingProbe,
  rangesProbe,
  runProbe,
  summarize,
  treatmentProbe,
  type FeatureScore,
  type Probe,
} from "@pablotech/akesi/benchmarks/model-portability";
import type { ReportSource } from "@pablotech/akesi/report-extract";
import { capsFor, modelId, parseInferenceConfig, INFERENCE, type Feature, type InferenceConfig } from "../src/lib/model-config";
import { modelFor } from "../functions/_lib/inference/resolve";
import { syntheticClient } from "../tests/fixtures/synthetic-patient";

const FIXTURES = join(import.meta.dirname, "..", "tests", "fixtures");

// Generating a Finding is minutes of streaming and dollars per case on a frontier model — an order
// of magnitude more than every other feature put together. It is measured, but never by accident:
// `--feature all` leaves it out and `--feature finding` runs it.
const EXPENSIVE: Feature[] = ["finding"];
// No synthetic photograph of a supplement exists, and a rendered document is not one. Measuring the
// image path on a page image would report a number for something nobody does. MEASUREMENT.md says so.
const UNMEASURED: Feature[] = ["treatmentImage", "chat", "persona", "leafRegen", "markerGroups", "benchmarkWeakest"];

const PATIENT = { dob: "1980-03-11", gender: "male" as const, factors: { diseases: [] } };
const TODAY = "2026-02-20";

/**
 * The same document in whichever form this feature's configured model declares it can take.
 *
 * Returns null when it declares neither — which is a RESULT, not an error: the app refuses that
 * feature with a 422 before a call is made (functions/_lib/inference/openai.ts), so the benchmark
 * refuses it too rather than billing a call it knows will be rejected.
 */
export async function sourceFor(feature: Feature, name: string, config: InferenceConfig): Promise<ReportSource | null> {
  const caps = capsFor(feature, config);
  if (caps.pdf) return { pdfBase64: (await readFile(join(FIXTURES, `${name}.pdf`))).toString("base64") };
  if (caps.vision) return { pageImages: [{ base64: (await readFile(join(FIXTURES, `${name}-p1.jpg`))).toString("base64"), mediaType: "image/jpeg" }] };
  return null;
}

/** How each document reached the model, so a row can never be read without knowing which route it scored. */
function route(source: ReportSource): string {
  return "pdfBase64" in source ? "native PDF" : "pageImages" in source ? "page images" : "text";
}

export async function probesFor(features: Feature[], config: InferenceConfig): Promise<{ probes: Probe<never>[]; skipped: string[]; routes: string[] }> {
  const probes: Probe<never>[] = [];
  const skipped: string[] = [];
  const routes: string[] = [];
  const add = <C,>(p: Probe<C>) => probes.push(p as unknown as Probe<never>);

  if (features.includes("ranges")) add(rangesProbe());

  if (features.includes("extract")) {
    const source = await sourceFor("extract", "synthetic-report", config);
    if (!source) skipped.push("extract — the configured model declares neither pdf nor vision");
    else {
      routes.push(`extract: ${route(source)}`);
      add(extractProbe([{ label: "lab panel + coronary CTA", source, sourceFile: "synthetic-report.pdf", patient: PATIENT, today: TODAY }]));
    }
  }

  if (features.includes("document")) {
    const cases = [];
    for (const name of ["synthetic-report", "synthetic-note"]) {
      const source = await sourceFor("document", name, config);
      if (source) {
        cases.push({ label: name, source, sourceFile: `${name}.pdf` });
        routes.push(`document/${name}: ${route(source)}`);
      }
    }
    if (cases.length === 0) skipped.push("document — the configured model declares neither pdf nor vision");
    else add(documentProbe(cases));
  }

  if (features.includes("treatmentText")) {
    add(
      treatmentProbe("treatmentText", [
        { label: "creatine, plain", input: { text: "Creatine monohydrate 5 g, one scoop daily" } },
        { label: "vitamin D, IU", input: { text: "Colecalciferol 1000 IU softgel, one daily with food" } },
        { label: "label transcript", input: { text: "MAGNESIUM GLYCINATE. Serving size 2 capsules. Amount per serving: magnesium (as magnesium bisglycinate chelate) 200 mg. Take 2 capsules in the evening." } },
      ]),
    );
  }

  if (features.includes("finding")) add(findingProbe([syntheticClient("bench")]));

  return { probes, skipped, routes };
}

export function table(scores: FeatureScore[]): string {
  const rows = scores.map((s) => {
    const ci = `[${s.ci[0].toFixed(2)}, ${s.ci[1].toFixed(2)}]`;
    const top = s.rejections[0] ? `${s.rejections[0].bucket} (${s.rejections[0].count})` : "—";
    return `| ${s.feature} | \`${s.model}\` | ${s.n} | ${s.passed}/${s.n} | ${ci} | ${(s.firstAttemptPassRate * 100).toFixed(0)}% | ${s.meanAttempts.toFixed(2)} | ${(s.medianMs / 1000).toFixed(1)} | ${top} |`;
  });
  return [
    "| feature | model | n | validated | 95% CI | first try | mean attempts | median s | commonest rejection |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function rejectionDetail(scores: FeatureScore[]): string {
  const lines: string[] = [];
  for (const s of scores) {
    if (s.rejections.length === 0) continue;
    lines.push(`- **${s.feature}** — ${s.rejections.map((r) => `${r.bucket} ×${r.count}`).join(", ")}`);
    for (const r of s.rejections) lines.push(`  - \`${r.bucket}\`: ${r.example}`);
  }
  return lines.join("\n");
}

const PREREGISTRATION = `
Pre-registration — recorded before the run (pilos/CONTRIBUTING.md).

- **Claim under test.** INFERENCE.md said the prompts "were written and checked against Claude" and
  that a smaller model "may fail validation more often". That is an unmeasured claim about every
  other model. This measures it.
- **Oracle.** akesi's own validate() — the function that decides in production whether a response is
  usable. Never a rubric, never a second model.
- **Outcome.** Per feature × model: validated / n with a Wilson interval, the first-attempt rate,
  and mean attempts censored one past the shipped ceiling. Higher pass rate is better; lower mean
  attempts is better.
- **Cases.** Synthetic and committed: tests/fixtures/synthetic-report.{pdf,-p1.jpg},
  synthetic-note.{pdf,-p1.jpg}, akesi's twelve SI-unit ranges cases, three supplement descriptions,
  one synthetic patient. No PHI, in a public repo.
- **Route is reported, not chosen.** A document goes as a native PDF or as page images according to
  what the configured provider DECLARES it can take, so a row always says which one it scored.
- **What each outcome will mean.** A model at or near Claude on a feature is a usable alternative
  for that feature and is named in MODELS.md. A model that validates but needs more attempts is
  usable and slower, and is named as such. A model that fails on a feature is not recommended for
  that feature, and the rejection buckets say why. A flat or negative result publishes unchanged.
- **Not measured.** ${UNMEASURED.join(", ")}, and anything a run skips for a declared missing
  capability. Absence of a number is reported as absence, never as a pass.
`.trim();

async function main(): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };

  const configPath = arg("config");
  const config = configPath ? parseInferenceConfig(JSON.parse(await readFile(configPath, "utf8"))) : INFERENCE;

  const asked = arg("feature") ?? "all";
  const features: Feature[] =
    asked === "all"
      ? (["ranges", "extract", "document", "treatmentText"] as Feature[])
      : (asked.split(",").map((f) => f.trim()) as Feature[]);

  const { probes, skipped, routes } = await probesFor(features, config);

  if (process.argv.includes("--preview")) {
    process.stdout.write(`config: ${configPath ?? "inference.config.json (committed default)"}\n\n`);
    for (const b of budget(probes)) {
      process.stdout.write(`  ${b.feature.padEnd(16)} ${String(b.cases).padStart(3)} case${b.cases === 1 ? " " : "s"}  ≤ ${b.maxCallsPerModel} call${b.maxCallsPerModel === 1 ? "" : "s"} on ${modelId(b.feature as Feature, "prod", config)}\n`);
    }
    for (const r of routes) process.stdout.write(`  route — ${r}\n`);
    for (const s of skipped) process.stdout.write(`  skipped — ${s}\n`);
    const costly = features.filter((f) => EXPENSIVE.includes(f));
    if (costly.length > 0) process.stdout.write(`\n  ${costly.join(", ")}: minutes and dollars per case. Named explicitly, never run by "all".\n`);
    process.stdout.write(`\n${PREREGISTRATION}\n\nno call made.\n`);
    return;
  }

  const scores: FeatureScore[] = [];
  for (const probe of probes) {
    const feature = probe.feature as Feature;
    const { client, model } = modelFor(process.env, feature, "prod", config);
    process.stderr.write(`${feature} on ${model}: ${probe.cases.length} cases…\n`);
    scores.push(summarize(await runProbe(client, model, probe), probe));
  }

  process.stdout.write(`\n${table(scores)}\n\n${rejectionDetail(scores)}\n`);
  for (const s of skipped) process.stdout.write(`\n- not run: ${s}`);
  process.stdout.write("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

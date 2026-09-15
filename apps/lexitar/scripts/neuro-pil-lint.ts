import { validate, sliceParity } from "@pablotech/neuro";
import { findingDag } from "../src/lib/finding-dag";
import { INPUT_SLICES } from "../src/lib/node-input-hash";

// W61 — `npm run neuro-pil:lint` runs the same checks tests/unit/finding-dag.test.ts asserts
// against in CI, as a standalone command for local iteration (e.g. right after editing FINDING_DAG,
// before writing a test). See docs/health-dash/plans/61-w61-graph-brain-extraction.md.
function main() {
  const findings = [...validate(findingDag), ...sliceParity(findingDag, INPUT_SLICES)];
  if (findings.length === 0) {
    process.stdout.write(`neuro-pil: no findings across ${findingDag.nodes.length} nodes.\n`);
    return;
  }
  for (const f of findings) process.stdout.write(`[${f.rule}] ${f.node}: ${f.message}\n`);
  process.exitCode = 1;
}

main();

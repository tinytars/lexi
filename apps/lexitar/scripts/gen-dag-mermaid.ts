import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderMermaid as renderMermaidDag, extractDagBlock, writeDagBlock } from "@pablotech/neuro";
import { findingDag } from "../src/lib/finding-dag";

// W15b — the DAG diagram in docs/health-dash/plans/15-finding-dag.md is generated from FINDING_DAG,
// not hand-maintained, so the picture can never drift from the code. `npm run dag:mermaid` rewrites
// the fenced block between the markers; a unit test (finding-dag.test.ts) pins that the checked-in
// block equals renderMermaid(findingDag), which is the drift guard in the absence of CI.
// W61 — renderMermaid/extractDagBlock/writeDagBlock moved to @pablotech/neuro/mermaid.ts; this file
// keeps only the doc path and the read/write entrypoint.

const DOC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/health-dash/plans/15-finding-dag.md");

export function docPath(): string {
  return DOC;
}

// Re-exported (renderMermaid curried to findingDag) so finding-dag.test.ts's import doesn't change.
export { extractDagBlock };
export function renderMermaid(): string {
  return renderMermaidDag(findingDag);
}

function main() {
  const doc = readFileSync(DOC, "utf8");
  writeFileSync(DOC, writeDagBlock(doc, findingDag));
  process.stdout.write(`Wrote ${findingDag.nodes.length}-node mermaid into ${DOC}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

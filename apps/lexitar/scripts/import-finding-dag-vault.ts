import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dagFromFiles, parseVaultNode } from "@pablotech/neuro-pil/markdown";
import { validate } from "@pablotech/neuro-pil";
import type { Dag, DagNode } from "@pablotech/neuro-pil";

// The pull direction of the clinical-vault relationship: reads a vault of expert-editable markdown
// notes (e.g. ~/PabloTech/clinical-vault/finding-dag) and regenerates
// apps/health-dash-web/src/lib/finding-dag.ts from it. finding-dag.ts is generated from here on —
// clinical-vault's markdown is the authored source, this script is the codegen step, and
// `npm run dag:push` is what seeds/updates the vault the other direction. `npm run dag:pull -- --in
// <path>`.
//
// Vault edits get full structural authority (add/remove/rewire nodes, not just prose) precisely
// because this refuses to regenerate on a lint failure: an expert can point an input at a key that no
// longer exists, orphan a node, or introduce a cycle, and @pablotech/neuro-pil's validate() (the same
// check brain/neuro-pil/cli.ts's `lint` subcommand runs) catches it here before it ever reaches the
// app.

const PLACEHOLDER = "{{PRODUCT_NAME}}";

interface Args {
  inDir: string;
}

function parseArgs(argv: string[]): Args {
  let inDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") inDir = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!inDir) throw new Error("--in <path> is required (a brain folder, e.g. ~/PabloTech/clinical-vault/finding-dag)");
  return { inDir };
}

// Mirrors brain/neuro-pil/cli.ts's walkVault exactly (recursive *.md/*.neuro-pil.yml collection,
// skipping dotfiles/node_modules) rather than importing it: cli.ts isn't part of @pablotech/neuro-pil's
// package exports (see its package.json `exports` map), and adding one there is a neuro-pil change
// this plumbing is deliberately meant not to require.
function walkVault(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const p = join(d, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (entry.name.endsWith(".md") || entry.name.endsWith(".neuro-pil.yml")) out[p] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const REASONING_HEADING = /^## Reasoning\s*$/m;

// Extracts a vault note's `## Reasoning` section (heading to the next `##` heading or EOF) from
// its raw markdown. Handled here, not in @pablotech/neuro-pil: `reasoning` is domain-specific
// clinical content the public, domain-free engine must never parse or know the shape of.
export function extractReasoning(text: string): string | undefined {
  const start = text.search(REASONING_HEADING);
  if (start === -1) return undefined;
  const afterHeading = text.slice(start).replace(REASONING_HEADING, "").replace(/^\r?\n+/, "");
  const nextHeading = afterHeading.search(/^##\s/m);
  const body = (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)).trim();
  return body || undefined;
}

// Resolves a `{{PRODUCT_NAME}}`-bearing string into a template literal referencing PRODUCT_NAME
// (`./brand`); a string with no placeholder stays a plain double-quoted literal.
function renderStringField(value: string): string {
  if (!value.includes(PLACEHOLDER)) return JSON.stringify(value);
  const escaped = value
    .split(PLACEHOLDER)
    .map((part) => part.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"))
    .join("${PRODUCT_NAME}");
  return `\`${escaped}\``;
}

function renderNode(node: DagNode & { reasoning?: string }): string {
  const fields = [
    `key: ${JSON.stringify(node.key)}`,
    `label: ${renderStringField(node.label)}`,
    `kind: ${JSON.stringify(node.kind)}`,
    `inputs: [${node.inputs.map((k) => JSON.stringify(k)).join(", ")}]`,
    `basis: ${renderStringField(node.basis)}`,
    ...(node.reasoning ? [`reasoning: ${renderStringField(node.reasoning)}`] : []),
    ...(node.note ? ["note: true"] : []),
    ...(node.noteSink ? ["noteSink: true"] : []),
  ];
  return `  { ${fields.join(", ")} },`;
}

function renderModule(dag: Dag, reasoningByKey: Map<string, string>): string {
  const nodes = [...dag.nodes]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((n) => ({ ...n, reasoning: reasoningByKey.get(n.key) }));
  return `// GENERATED — do not hand-edit. This is codegen'd from clinical-vault's finding-dag/ notes by
// apps/health-dash-web/scripts/import-finding-dag-vault.ts (\`npm run dag:pull\`). To change the graph,
// edit the vault (Obsidian-openable markdown) and pull again; \`npm run dag:push\` seeds/updates the
// vault from whatever this file currently holds.

import { PRODUCT_NAME } from "./brand";
import { defineDag, type DagNode, type NodeKind } from "@pablotech/neuro-pil";

export type { DagNode, NodeKind };

// Extends the shared, domain-free DagNode with clinical-reasoning prompt text pulled from
// clinical-vault's \`## Reasoning\` sections. Kept local to this app — never added to
// @pablotech/neuro-pil, which must stay domain-free.
export interface FindingDagNode extends DagNode {
  reasoning?: string;
}

export const FINDING_DAG: FindingDagNode[] = [
${nodes.map(renderNode).join("\n")}
];

export const findingDag = defineDag(FINDING_DAG);

export const { upstreamOf, downstreamOf } = findingDag;

// defineDag's Dag interface isn't generic over the node type — dagNode() is typed to return the
// base DagNode. FINDING_DAG is actually FindingDagNode[], so the runtime value always carries
// \`reasoning\`; this cast restores that at the type level without touching neuro-pil.
export const dagNode = findingDag.dagNode as (key: string) => FindingDagNode | undefined;
`;
}

// A second generated output, for brain/akesi-pil's own prompt files (finding-generate.ts,
// marker-groups-prompt.ts): they can't import from apps/health-dash-web/src/lib/finding-dag.ts —
// apps/health-dash-web depends on brain/akesi-pil, never the reverse — so the reasoning map is
// duplicated here as a same-package generated file. The vault stays the one authored source.
function renderReasoningModule(reasoningByKey: Map<string, string>): string {
  const entries = [...reasoningByKey.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `// GENERATED — do not hand-edit. This is codegen'd from clinical-vault's finding-dag/ notes by
// apps/health-dash-web/scripts/import-finding-dag-vault.ts (\`npm run dag:pull\`). To change the
// content, edit the vault (Obsidian-openable markdown) and pull again. A same-package copy of
// apps/health-dash-web/src/lib/finding-dag.ts's per-node \`reasoning\` field — see that file's
// header for why this is a separate output. Plain string literals: this is LLM prompt content,
// not UI copy, so it carries no {{PRODUCT_NAME}} placeholder to resolve.

export const REASONING: Record<string, string> = {
${entries.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`).join("\n")}
};
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inDir = resolve(args.inDir);

  const files = walkVault(inDir);
  const rawDag = dagFromFiles(files);
  const findings = validate(rawDag);
  if (findings.length > 0) {
    process.stderr.write(`dag:pull refused — ${findings.length} lint finding(s) in ${inDir}:\n`);
    for (const f of findings) process.stderr.write(`  [${f.rule}] ${f.node}: ${f.message}\n`);
    process.exitCode = 1;
    return;
  }

  const reasoningByKey = new Map<string, string>();
  for (const text of Object.values(files)) {
    const meta = parseVaultNode(text);
    const reasoning = extractReasoning(text);
    if (meta && reasoning) reasoningByKey.set(meta.node, reasoning);
  }

  const outPath = resolve(import.meta.dirname, "../src/lib/finding-dag.ts");
  writeFileSync(outPath, renderModule(rawDag, reasoningByKey));
  process.stdout.write(`Wrote ${rawDag.nodes.length} nodes to ${outPath}\n`);

  const reasoningOutPath = resolve(import.meta.dirname, "../../../brain/akesi-pil/reasoning.ts");
  writeFileSync(reasoningOutPath, renderReasoningModule(reasoningByKey));
  process.stdout.write(`Wrote ${reasoningByKey.size} reasoning entries to ${reasoningOutPath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

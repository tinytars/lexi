import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { dagToFiles } from "@pablotech/neuro-pil/markdown";
import { findingDag, FINDING_DAG } from "../src/lib/finding-dag";
import { PRODUCT_NAME } from "../src/lib/brand";

// Writes FINDING_DAG out as an Obsidian-openable vault: one markdown note per node, via
// @pablotech/neuro-pil's dagToFiles (brain/neuro-pil/markdown.ts). The engine is public
// (alex-tech/pilos); this script's default output is not — docs/cross-app/06-open-source-akesi-pil.md
// requires the public repo carry no LexiTar/product branding.
//
// The literal PRODUCT_NAME is replaced with a `{{PRODUCT_NAME}}` placeholder token in every file's
// content: the destination vault (clinical-vault) is meant to hold more than one product's "brain"
// over time, so its content shouldn't be pre-baked with one product's name. `npm run dag:pull`
// resolves the token back when regenerating finding-dag.ts. `npm run dag:push [-- --out <path>]`.

const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../.finding-dag-vault");

interface Args {
  outDir?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.outDir = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

export function outDir(): string {
  return DEFAULT_OUT_DIR;
}

// Appended, not handled by @pablotech/neuro-pil's dagToFiles: `reasoning` is domain-specific
// clinical content the public, domain-free engine must never parse or know the shape of. Inverse of
// import-finding-dag-vault.ts's extractReasoning.
export function appendReasoning(content: string, reasoning: string | undefined): string {
  return reasoning ? `${content.trimEnd()}\n\n## Reasoning\n\n${reasoning}\n` : content;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.outDir ? resolve(args.outDir) : DEFAULT_OUT_DIR;

  const reasoningByKey = new Map(FINDING_DAG.map((n) => [n.key, n.reasoning]));

  rmSync(target, { recursive: true, force: true });
  for (const [path, content] of Object.entries(dagToFiles(findingDag))) {
    const key = path.replace(/\.md$/, "");
    const withReasoning = appendReasoning(content, reasoningByKey.get(key));
    const full = join(target, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, withReasoning.replaceAll(PRODUCT_NAME, "{{PRODUCT_NAME}}"));
  }
  process.stdout.write(`Wrote ${findingDag.nodes.length} nodes to ${target}\n`);
  process.stdout.write("Open it in Obsidian: File -> Open folder as vault, then switch to the graph view.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();

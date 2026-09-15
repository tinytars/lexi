import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// W68 — the Node CLI must not carry browser transport.
//
// `scripts/vault-verify.ts` and `scripts/ingest.ts` imported `attachmentKeysOf` from
// attachment-store.ts, which imports document-extract-client.ts and extract-client.ts — modules whose
// only job is `fetch("/api/...")` against a relative URL a CLI can never resolve. Nothing crashed,
// because the fetch calls are function-scoped, so this stayed invisible: the CLI simply loaded and
// carried code it could never run.
//
// Static source walk, same shape as refresh-range-import-graph.test.ts: no bundler, no runtime import,
// so a dynamic `import()` cannot hide an edge and the test costs nothing to run.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FROM_CLAUSE = /(?:import|export)[^;]*?\bfrom\s*["']([^"']+)["']/g;

// 06 Phase A step 13 moved a chunk of the clinical layer into brain/akesi-pil, reached from the CLI
// only via the bare "@pablotech/akesi/..." specifier. Without this, the walk would stop dead at the
// package boundary and never see whether anything past it calls a relative fetch.
const AKESI_PIL_ROOT = resolve(ROOT, "..", "..", "brain", "akesi-pil");
const AKESI_PIL_EXPORTS: Record<string, string> = JSON.parse(
  readFileSync(join(AKESI_PIL_ROOT, "package.json"), "utf8"),
).exports;

function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  if (specifier === "@pablotech/akesi" || specifier.startsWith("@pablotech/akesi/")) {
    const subpath = specifier === "@pablotech/akesi" ? "." : `.${specifier.slice("@pablotech/akesi".length)}`;
    const target = AKESI_PIL_EXPORTS[subpath];
    return target ? resolve(AKESI_PIL_ROOT, target) : undefined;
  }
  if (!specifier.startsWith(".")) return undefined; // other npm or node: builtin — not our source graph
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function transitiveImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(FROM_CLAUSE)) {
      const r = resolveSpecifier(m[1], file);
      if (r && !seen.has(r)) queue.push(r);
    }
  }
  seen.delete(entry);
  return seen;
}

/** A module that fetches a RELATIVE url is browser-only by construction — a CLI has no origin. */
function callsRelativeFetch(file: string): boolean {
  return /\bfetch\(\s*[`"']\/(?!\/)/.test(readFileSync(file, "utf8"));
}

const cliEntries = readdirSync(resolve(ROOT, "scripts"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => resolve(ROOT, "scripts", f));

describe("the Node CLI never reaches a browser-only transport module", () => {
  it("finds the CLI entry points at all, so an empty sweep cannot pass silently", () => {
    expect(cliEntries.length).toBeGreaterThan(10);
  });

  it.each(cliEntries.map((f) => [f.slice(ROOT.length + 1), f]))("%s", (_name, entry) => {
    const offenders = [...transitiveImports(entry)]
      .filter(callsRelativeFetch)
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});

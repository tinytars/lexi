import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// M59/Phase 2 scope discipline — a cheap static guard that /api/refresh-range's module graph
// never grows an edge into the Finding inference graph. Walks the file's own static import/export
// specifiers (no bundler, no runtime import — just source text) so it can't be fooled by a
// dynamic `import()` and doesn't pay for booting the real module tree.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = resolve(ROOT, "functions/api/refresh-range.ts");
const FORBIDDEN = ["finding-generate.ts", "finding-assemble.ts", "finding-dag.ts"];

const FROM_CLAUSE = /(?:import|export)[^;]*?\bfrom\s*["']([^"']+)["']/g;

// 06 Phase A step 13 moved finding-generate.ts and finding-assemble.ts into brain/akesi-pil, reached
// from the app only via the bare "@pablotech/akesi-pil/..." specifier. Without this, the walk would stop
// dead at the package boundary — every edge past it invisible, including the ones this test exists
// to forbid — and pass whether or not they're still there.
const AKESI_PIL_ROOT = resolve(ROOT, "..", "..", "brain", "akesi-pil");
const AKESI_PIL_EXPORTS: Record<string, string> = JSON.parse(
  readFileSync(join(AKESI_PIL_ROOT, "package.json"), "utf8"),
).exports;

function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  if (specifier === "@pablotech/akesi-pil" || specifier.startsWith("@pablotech/akesi-pil/")) {
    const subpath = specifier === "@pablotech/akesi-pil" ? "." : `.${specifier.slice("@pablotech/akesi-pil".length)}`;
    const target = AKESI_PIL_EXPORTS[subpath];
    return target ? resolve(AKESI_PIL_ROOT, target) : undefined;
  }
  if (!specifier.startsWith(".")) return undefined; // other bare/npm or node: builtin — not part of our source graph
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function transitiveImports(entry: string): Set<string> {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(FROM_CLAUSE)) {
      const resolved = resolveSpecifier(match[1], file);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  visited.delete(entry);
  return visited;
}

describe("/api/refresh-range module-graph isolation", () => {
  it("never transitively imports the Finding inference graph", () => {
    const imports = [...transitiveImports(ENTRY)];
    const offenders = imports.filter((f) => FORBIDDEN.some((name) => f.endsWith(`/${name}`)));
    expect(offenders).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// W62 — these three existed 4x/5x/5x, and three of the copies carried comments blessing the
// duplication that cited each other as precedent. This is the structural guard against a sixth.
//
// It stays in the host because its subject IS the host: it scans this app's src/ for redeclarations
// of helpers the package owns. The behaviour of those helpers is tested in the package itself
// (brain/akesi-pil/tests/report-title.test.ts) — the two halves used to share a file and did not
// share a subject.
describe("they are defined exactly once", () => {
  function sources(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) sources(p, out);
      else if (/\.(ts|svelte)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const FILES = sources(resolve("src")).filter((f) => !f.endsWith("report-title.ts"));

  it("no other file re-declares the title, date or kind-label helper", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      // A DECLARATION, not a call: `const X =` / `function X(`.
      if (/(?:const|function)\s+\w*(?:KIND_LABEL|kindLabel)\b/.test(src)) offenders.push(`${f}: kind label`);
      if (/(?:const|function)\s+\w*[dD]ateOf\s*[=(]/.test(src) && !/dateKeyOf/.test(src.match(/(?:const|function)\s+\w*[dD]ateOf\s*[=(]/)![0])) offenders.push(`${f}: dateOf`);
      if (/function\s+\w*[tT]itleOf\s*\(/.test(src)) offenders.push(`${f}: titleOf`);
    }
    expect(offenders.map((o) => o.replace(resolve("."), "."))).toEqual([]);
  });
});

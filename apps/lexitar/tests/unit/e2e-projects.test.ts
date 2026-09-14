import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYNTHETIC_SPECS } from "../../playwright.config";

// W69 — the `synthetic` Playwright project is a promise: these specs need no credential and no real
// patient, so they can run somewhere other than this Mac.
//
// A hand-maintained list of files is exactly the kind of thing that rots — a spec grows an
// `openPatient()` call and the list still claims it is portable, which surfaces months later as a
// hosted job failing at collection with an opaque "PASSPHRASE not set". So the list is checked against
// what the sources actually import, in BOTH directions: nothing in the list may touch the pilots, and
// nothing outside it may be pilot-free (a portable spec left in `pilots` is a spec that needlessly
// pins work to this laptop).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const E2E = join(ROOT, "tests/e2e");

/** Any reach for a real pilot — Alex, Blair, or the fam4 provider whose password is the family passphrase. */
const TOUCHES_PILOTS = /\bPILOTS\.(alex|blair|provider)\b|\bopenPatient\b|\bopenPatientNamed\b|\bopenAsProvider\b|\bPILOT_BY_NAME\b/;

const specFiles = readdirSync(E2E).filter((f) => f.endsWith(".spec.ts"));

/**
 * Which exports of a local helper module can reach a pilot.
 *
 * W74 — reading the spec's own text was enough only while every pilot call was written in the spec.
 * Then `shell-nav.spec.ts` was split seven ways, its `unlock()` moved to `_shell.ts`, and this test
 * immediately declared `shell-phone.spec.ts` credential-free — it drives the pilots through a helper,
 * one import away. Listing it would have put a spec that needs the family passphrase into the project
 * defined by not needing one.
 *
 * Per SYMBOL, not per file: every synthetic spec imports `loginAs` from `_login.ts`, which is also
 * where `openPatientNamed` and `PILOTS` are DEFINED. Tainting a whole module by its filename would
 * condemn the entire synthetic project — which is exactly how the first attempt at this failed.
 */
/**
 * Comments are not calls. `PILOT_BY_NAME`'s doc comment mentions `openPatient()`, and it sits between
 * `loginAs`'s closing brace and the next export — attributing it to `loginAs` tainted the one helper
 * every synthetic spec imports, and condemned the whole project.
 *
 * Block comments and whole-line `//` only: a trailing `// note` after code is rare here, and stripping
 * those naively would eat the `//` in a URL.
 */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");

function taintedExports(module: string): Set<string> {
  const text = stripComments(readFileSync(join(E2E, module), "utf8"));
  const tainted = new Set<string>();
  // Each export's body runs to the next export — enough to attribute one, and it never spans files.
  const decls = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)];
  const bodyOf = (i: number) => text.slice(decls[i].index!, decls[i + 1]?.index ?? text.length);
  for (let i = 0; i < decls.length; i++) if (TOUCHES_PILOTS.test(bodyOf(i))) tainted.add(decls[i][1]);
  // A helper that calls a tainted helper is tainted too — `unlock` reaches `openPatientNamed`.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < decls.length; i++) {
      for (const t of [...tainted]) if (new RegExp(`\\b${t}\\b`).test(bodyOf(i))) tainted.add(decls[i][1]);
    }
  }
  return tainted;
}

/** Does this spec reach a pilot — directly, or through a symbol it imports from a local helper? */
function touchesPilots(file: string): boolean {
  const text = stripComments(readFileSync(join(E2E, file), "utf8"));
  if (TOUCHES_PILOTS.test(text)) return true;
  for (const [, names, spec] of text.matchAll(/import\s+\{([^}]*)\}\s+from\s+"(\.\/[^"]+)"/g)) {
    const module = spec.replace(/^\.\//, "") + (spec.endsWith(".ts") ? "" : ".ts");
    if (!existsSync(join(E2E, module))) continue;
    const tainted = taintedExports(module);
    const imported = names.split(",").map((n) => n.replace(/^\s*type\s+/, "").split(" as ")[0].trim());
    if (imported.some((n) => tainted.has(n))) return true;
  }
  return false;
}

describe("the synthetic e2e project is genuinely credential-free", () => {
  it("finds the specs at all, so an empty sweep cannot pass silently", () => {
    expect(specFiles.length).toBeGreaterThan(30);
    expect(SYNTHETIC_SPECS.length).toBeGreaterThan(0);
  });

  it("every listed spec exists", () => {
    for (const f of SYNTHETIC_SPECS) expect(existsSync(join(E2E, f)), f).toBe(true);
  });

  it("no listed spec reaches for a real pilot", () => {
    expect(SYNTHETIC_SPECS.filter(touchesPilots)).toEqual([]);
  });

  // The other direction. Without it the list silently under-claims: a spec that could run hosted stays
  // pinned to the Mac, and nothing ever says so.
  it("every pilot-free spec is listed", () => {
    const portable = specFiles.filter((f) => !touchesPilots(f)).sort();
    expect([...SYNTHETIC_SPECS].sort()).toEqual(portable);
  });

  it("the two projects partition the suite — no spec in both, none in neither", () => {
    const listed = new Set(SYNTHETIC_SPECS);
    const inPilots = specFiles.filter((f) => !listed.has(f));
    expect(inPilots.length + SYNTHETIC_SPECS.length).toBe(specFiles.length);
    expect(SYNTHETIC_SPECS.some((f) => inPilots.includes(f))).toBe(false);
  });
});

// The other half of the promise, and the one that actually blocked hosted e2e: _login.ts resolved the
// family PASSPHRASE at MODULE scope and threw there. Nearly every spec imports that file — including
// the portable ones — so a credential-less runner died at collection before any project selection
// could help. Needing a credential to RUN must not mean needing one to IMPORT.
describe("_login.ts does not demand a credential just to be imported", () => {
  const source = readFileSync(join(E2E, "_login.ts"), "utf8");

  it("reads PASSPHRASE only inside a function, never at module scope", () => {
    const atModuleScope = source
      .split("\n")
      .filter((l) => l.includes("process.env.PASSPHRASE"))
      .filter((l) => !/^\s/.test(l)); // an unindented line is top-level
    expect(atModuleScope).toEqual([]);
  });

  it("still fails loudly, by name, when the provider is actually used", () => {
    expect(source).toMatch(/throw new Error\("PASSPHRASE not set/);
  });
});

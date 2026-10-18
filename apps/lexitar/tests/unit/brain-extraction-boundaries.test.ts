import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Clinical modules headed for an extracted brain package must not re-acquire UI imports.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const importsOf = (src: string) => [...src.matchAll(/from\s+"((?:\.|@pablotech\/akesi)[^"]+)"/g)].map((m) => m[1]);

/** Modules that are UI by nature — a clinical module reaching one is the failure being prevented. */
const UI_MODULES = /sidebar-leaf-mappers|sidebar-rows|sidebar-labels|sidebar-leaf-rows|permalink|anchor|\.svelte$/;

describe("the clinical layer does not reach into the UI", () => {
  // Paths under node_modules/@pablotech/akesi are the modules already moved out of the app.
  it.each([
    "../../node_modules/@pablotech/akesi/treatment-normalize.ts",
    "../../node_modules/@pablotech/akesi/treatment-bucket.ts",
    "../../node_modules/@pablotech/akesi/ranges.ts",
    "../../node_modules/@pablotech/akesi/ranges-prompt.ts",
    "src/lib/finding-dag.ts",
    "src/lib/finding-invariants.ts",
    "src/lib/node-input-hash.ts",
  ])("%s imports no UI module", (f) => {
    expect(importsOf(read(f)).filter((i) => UI_MODULES.test(i))).toEqual([]);
  });

  it("the UI-module list matches real files, so the guard cannot pass by misspelling", () => {
    const libFiles = readdirSync(join(ROOT, "src/lib"));
    for (const stem of ["sidebar-leaf-mappers", "sidebar-labels", "permalink"]) {
      expect(libFiles, stem).toContain(`${stem}.ts`);
    }
    // sidebar-rows lives in packages/frame; its @tinytars/frame/sidebar-rows specifier still matches UI_MODULES.
    const frameFiles = readdirSync(join(ROOT, "..", "..", "packages/frame"));
    expect(frameFiles, "sidebar-rows").toContain("sidebar-rows.ts");
  });
});

// Permalink carries the UI's Tab union, so types.ts (moved into @pablotech/akesi) must not import it.
describe("types.ts carries no UI routing", () => {
  const types = read("../../node_modules/@pablotech/akesi/types.ts");

  it("does not import from permalink or nav", () => {
    expect(importsOf(types).filter((i) => /permalink|nav$/.test(i))).toEqual([]);
  });
});

describe("the widening is undone once, with a check rather than a cast", () => {
  it("asPermalink falls back instead of throwing on an unknown tab", async () => {
    // A stored attachment is patient data and may predate a tab rename. Throwing would lose the
    // reference entirely; falling back keeps the card visible and navigable.
    const { asPermalink } = await import("../../src/lib/permalink");
    const { DEFAULT_TAB } = await import("../../src/lib/nav");
    expect(asPermalink({ tab: "a-tab-that-no-longer-exists", anchor: "x" }).tab).toBe(DEFAULT_TAB);
    expect(asPermalink({ tab: "a-tab-that-no-longer-exists", anchor: "x" }).anchor).toBe("x");
  });

  it("passes a real tab through untouched, with its other fields", async () => {
    const { asPermalink } = await import("../../src/lib/permalink");
    expect(asPermalink({ client: "c", tab: "labs", section: "healthReports", anchor: "r1" })).toEqual({
      client: "c",
      tab: "labs",
      section: "healthReports",
      anchor: "r1",
    });
  });
});

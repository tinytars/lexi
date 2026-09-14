import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// W72 — the boundaries docs/cross-app/06 needs held, asserted rather than remembered.
//
// 06's Phase A found that the clinical reasoning layer looked clean at first-order imports and was
// not: the transitive closure from its roots is 49 files, and three things in it must not travel into
// an extracted brain package. Two of those are now severed. Nothing stops them being re-introduced by
// an import that looks harmless — which is what this file is for.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const importsOf = (src: string) => [...src.matchAll(/from\s+"((?:\.|@pablotech\/akesi-pil)[^"]+)"/g)].map((m) => m[1]);

/** Modules that are UI by nature — a clinical module reaching one is the failure being prevented. */
const UI_MODULES = /sidebar-leaf-mappers|sidebar-rows|sidebar-labels|sidebar-leaf-rows|permalink|anchor|\.svelte$/;

describe("the clinical layer does not reach into the UI", () => {
  // treatment-bucket.ts is the concrete case 06 names: bucketing, dose formatting and the assessment
  // lookup are pure, and were pinned to the app by ~60 lines of sidebar code at the bottom of the file.
  // 06 Phase A step 13 — moved wholesale into brain/akesi-pil; src/lib/treatment-bucket.ts no longer
  // exists (the shim was deleted), so this guard reads the declarations at their new path.
  it("treatment-bucket imports no UI module", () => {
    const offenders = importsOf(read("../../brain/akesi-pil/treatment-bucket.ts")).filter((i) => UI_MODULES.test(i));
    expect(offenders).toEqual([]);
  });

  it("and the sidebar half still exists, so the split was not just a deletion", () => {
    const sidebar = read("src/lib/treatment-sidebar.ts");
    for (const name of ["treatmentSidebarBuckets", "partitionByBucket", "TreatmentSidebarBucket"]) {
      expect(sidebar).toContain(name);
    }
    // It is allowed — required, even — to import both the UI and the clinical half.
    expect(importsOf(sidebar).some((i) => UI_MODULES.test(i))).toBe(true);
    expect(importsOf(sidebar)).toContain("@pablotech/akesi-pil/treatment-bucket");
  });

  // The other direction: the clinical modules 06 moved must not have acquired a UI import either.
  // The four that moved in step 13 are read at their new brain/akesi-pil path; the rest stayed app-side.
  it.each([
    "../../brain/akesi-pil/treatment-normalize.ts",
    "../../brain/akesi-pil/treatment-bucket.ts",
    "../../brain/akesi-pil/ranges.ts",
    "../../brain/akesi-pil/ranges-prompt.ts",
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
    // sidebar-rows.ts moved to packages/app-frame (doc 13) — its import specifier still matches
    // UI_MODULES as a substring (@tinytars/frame/sidebar-rows), so the boundary check above still
    // holds; this just points the "real file" half of the guard at its new location.
    const frameFiles = readdirSync(join(ROOT, "..", "..", "packages/app-frame"));
    expect(frameFiles, "sidebar-rows").toContain("sidebar-rows.ts");
  });
});

// 06's second named blocker: types.ts imported `Permalink` — the app's UI routing, including its Tab
// union — for a single field on NoteAttachment, in a module 194 files import and that 06 plans to
// move wholesale into the brain package.
describe("types.ts carries no UI routing", () => {
  // W72 step 6 — types.ts moved wholesale into brain/akesi-pil; src/lib/types.ts is now a barrel
  // re-exporting it. The declarations this guards live at the new path.
  const types = read("../../brain/akesi-pil/types.ts");

  it("does not import from permalink or nav", () => {
    expect(importsOf(types).filter((i) => /permalink|nav$/.test(i))).toEqual([]);
  });

  it("declares LeafRef with a widened tab, which is the whole mechanism", () => {
    // `tab: Tab` here would re-import the app's opinion about how many tabs exist; `tab: string`
    // keeps Permalink assignable to LeafRef while leaving the union to the UI.
    expect(types).toMatch(/interface LeafRef\s*\{[^}]*tab:\s*string/);
  });

  it("NoteAttachment points at LeafRef, not Permalink", () => {
    expect(types).toMatch(/permalink:\s*LeafRef/);
    expect(types).not.toMatch(/permalink:\s*Permalink/);
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

import { describe, it, expect } from "vitest";
import { syntheticClient, syntheticVault, workerSeed } from "../fixtures/synthetic-patient";
import { assembledFindingViolations } from "../../src/lib/finding-invariants";
import { buildSearchIndex } from "../../src/lib/search-index";

// W69 — a synthetic patient is only useful if it is a REALISTIC one.
//
// A fixture that merely typechecks will pass e2e specs that assert on structure and fail the moment a
// spec asserts on anything the app derives — grouping, staleness, coverage. So the acceptance test is
// the app's own invariant module (W67's finding-invariants.ts), which is what found 22 real defects in
// the live vaults. If the synthetic Finding satisfies the same eight rules the real ones must, it is a
// patient the app cannot tell from a real one, and specs can be moved onto it with confidence.

const SEEDS = [0, 1, 2, 3].map(workerSeed);

describe("the synthetic patient satisfies the same invariants a real one must", () => {
  it.each(SEEDS)("%s reports zero violations", (seed) => {
    expect(assembledFindingViolations(syntheticClient(seed))).toEqual([]);
  });

  // The whole point of per-worker patients: two workers must never collide. If the seeds produced
  // identical visible text, a cross-worker leak would be invisible — the failure this exists to catch
  // would look like a pass.
  it("different seeds produce different visible content", () => {
    const names = SEEDS.map((s) => syntheticClient(s).displayName);
    expect(new Set(names).size).toBe(SEEDS.length);
    const notes = SEEDS.map((s) => syntheticClient(s).factors!.noteEntries![0].text);
    expect(new Set(notes).size).toBe(SEEDS.length);
  });

  it("the vault is keyed by its seed, so two workers' blobs never overwrite each other", () => {
    expect(Object.keys(syntheticVault("w2").clients)).toEqual(["w2"]);
  });
});

// The specs worth moving onto this patient are the sidebar/search ones, and those are driven by
// buildSearchIndex. A fixture that is missing an entity kind would make a moved spec fail for a reason
// that has nothing to do with the code — so require every searchable kind to be present and findable.
describe("every searchable entity kind is present and indexed", () => {
  const index = buildSearchIndex(syntheticClient("w0"), []); // no chat threads — search is over the vault
  const haystack = JSON.stringify(index).toLowerCase();

  it("the index is non-trivial", () => {
    expect(index.length).toBeGreaterThan(10);
  });

  it.each([
    ["a note", "statin intolerance — w0"],
    ["a clinical report", "echocardiogram"],
    ["a diagnosis", "coronary calcification"],
    ["an allergy by allergen", "penicillin"],
    // W69 — and by REACTION, the other half of the same fix. The fixture carries "Hives".
    ["an allergy by reaction", "hives"],
    ["a family-history entry by relation", "mother"],
    // W69 — and by CONDITION, which is the half a patient would actually type. This assertion failed
    // when the fixture was written: familySidebarRows emitted no searchText, so the index carried
    // only "Mother". Fixed in sidebar-leaf-rows.ts; kept here so the fixture guards it too.
    ["a family-history entry by condition", "type 2 diabetes"],
    ["a study topic", "statin intolerance w0"],
    ["a glossary term", "apolipoprotein b"],
    ["a doctor question", "doctor question about"],
    ["a treatment", "rosuvastatin"],
    ["a patient hypothesis", "berberine"],
    ["an AI intervention", "bempedoic acid"],
    ["a marker", "apob"],
  ])("%s", (_kind, needle) => {
    expect(haystack).toContain(needle.toLowerCase());
  });

  it("markers carry enough dated readings for a chart to draw a line", () => {
    const byMarker = new Map<string, number>();
    for (const r of syntheticClient("w0").results) byMarker.set(r.marker, (byMarker.get(r.marker) ?? 0) + 1);
    expect(byMarker.size).toBeGreaterThanOrEqual(4);
    for (const [marker, n] of byMarker) expect(n, marker).toBeGreaterThanOrEqual(3);
  });
});

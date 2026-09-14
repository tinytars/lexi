import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTITY_KINDS, ENTITY_SPECS, entityForSidebarKind } from "../../src/lib/entity-kinds";
import { removeFrom } from "../../src/lib/vault-item-ops";
import { assembledFindingViolations } from "../../src/lib/finding-invariants";
import type { Client } from "../../src/lib/types";

// W70 Phase 4 — the registry has to be a CHECK, not a fifth copy of the same table.
//
// Four tables encoded the same few-entity fact and disagreed: the delete cascade covered three kinds,
// the invariants covered four. Deleting a clinical report therefore orphaned the AI's read of every
// diagnosis it carried, and the one table that would have caught it was the one the cascade never
// consulted. Consolidating is only worth doing if a future divergence cannot happen silently.
//
// Most of that guarantee is the TYPE system — `source` is `keyof ClientFactors`, `resultSection` is
// `keyof ClientFinding`, so a misspelt or missing field fails `npm run check`, which is already a
// hosted CI step. These tests cover what types cannot: that the consumers actually derive from the
// registry rather than quietly keeping their own list.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("the registry describes the entities as they really are", () => {
  it("covers the four patient-entered kinds", () => {
    expect(Object.keys(ENTITY_KINDS).sort()).toEqual(["allergy", "disease", "family", "note"]);
  });

  it("every id field is named after its own section", () => {
    // noteResults ↔ noteId, allergyResults ↔ allergyId … a mismatch here is exactly the pairing bug
    // W67 spent a milestone removing, in table form.
    for (const spec of ENTITY_SPECS) {
      expect(spec.resultSection).toBe(`${spec.idField.replace(/Id$/, "")}Results`);
    }
  });

  // The asymmetry that caused the orphan bug, now expressed in the type rather than in a comment.
  it("a diagnosis has no sidebar kind, because it is deleted with its report", () => {
    // Read through EntitySpec, not the literal: `as const satisfies` keeps the disease entry's exact
    // shape, which has NO sidebarKind property at all — so `ENTITY_KINDS.disease.sidebarKind` is a
    // type error rather than `undefined`. That precision is the feature; the test just has to respect it.
    expect(ENTITY_SPECS.find((e) => e.resultSection === "diseaseResults")!.sidebarKind).toBeUndefined();
    expect(entityForSidebarKind("note")?.resultSection).toBe("noteResults");
  });

  it("kinds that are not patient-entered entities resolve to nothing", () => {
    for (const kind of ["treatment", "medicine", "report", "marker", "ratio", "study"] as const) {
      expect(entityForSidebarKind(kind), kind).toBeUndefined();
    }
  });
});

describe("the consumers derive from the registry rather than keeping their own copy", () => {
  // Source assertions, deliberately: the whole failure mode was a consumer holding a private table
  // that drifted. A behavioural test passes either way while the copy exists.
  it("the delete cascade reads ENTITY_KINDS", () => {
    const src = read("src/lib/vault-item-ops.ts");
    expect(src).toContain("entityForSidebarKind");
    // The hand-written maps that disagreed with the invariants must be gone, not merely unused.
    expect(src).not.toMatch(/const byId = \{ note: "noteResults"/);
    expect(src).not.toMatch(/const idField = \{ note: "noteId"/);
  });

  it("the invariants read ENTITY_KINDS", () => {
    const src = read("src/lib/finding-invariants.ts");
    expect(src).toContain("ENTITY_SPECS");
    expect(src).not.toMatch(/\{ section: "noteResults", idField: "noteId"/);
  });
});

// Behaviour, unchanged by the consolidation — the point of a refactor is that these still hold.
function client(): Client {
  return {
    displayName: "T",
    watchlist: [],
    results: [],
    factors: {
      noteEntries: [{ id: "n1", text: "kept" }, { id: "n2", text: "doomed" }],
      allergies: [{ id: "al1", allergen: "Pollen", reaction: "" }],
      familyHistory: [{ id: "fh1", relation: "Mother", condition: "T2D" }],
      diseases: [{ id: "dx1", date: "2021-10", diagnostic: "CAD" }],
    },
    finding: {
      disease: [{ group: "Cardiovascular Risk", finding: "x" }],
      noteResults: [
        { noteId: "n1", result: "about n1", group: "Cardiovascular Risk" },
        { noteId: "n2", result: "about n2", group: "Cardiovascular Risk" },
      ],
      allergyResults: [{ allergyId: "al1", result: "r", group: "Cardiovascular Risk" }],
      familyResults: [{ familyId: "fh1", result: "r", group: "Cardiovascular Risk" }],
      diseaseResults: [{ diseaseId: "dx1", result: "r", group: "Cardiovascular Risk" }],
    },
  } as unknown as Client;
}

describe("deleting a row still takes the AI's turn about it", () => {
  it.each([
    ["note", "n2", "noteResults", ["n1"]],
    ["allergy", "al1", "allergyResults", []],
    ["family", "fh1", "familyResults", []],
  ] as const)("%s", (kind, id, section, remaining) => {
    const out = removeFrom(client(), kind, id);
    const rows = (out.finding as unknown as Record<string, { [k: string]: string }[]>)[section];
    const spec = ENTITY_SPECS.find((e) => e.resultSection === section)!;
    expect(rows.map((r) => r[spec.idField])).toEqual(remaining);
  });

  it("and the invariants agree there are no orphans left", () => {
    let c = client();
    for (const [kind, id] of [["note", "n2"], ["allergy", "al1"], ["family", "fh1"]] as const) c = removeFrom(c, kind, id);
    expect(assembledFindingViolations(c).filter((v) => /matches no row on file/.test(v))).toEqual([]);
  });
});

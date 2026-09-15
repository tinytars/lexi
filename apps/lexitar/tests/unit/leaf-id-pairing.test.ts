import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEAF_REGEN_SPECS, validateLeafResult, leafContextFor } from "../../src/lib/leaf-regen-registry";
import type { Client } from "../../src/lib/types";

// W67 — the four id-keyed row leaves used to pair the model's answers to patient rows by ARRAY
// POSITION. A model that skipped one row therefore filed every subsequent answer against the WRONG
// row, silently: a note's AI response attributed to a different note. Nothing detected it, because
// nothing anywhere compared what came back against what was asked. These tests are that comparison.
//
// The four are covered as a TABLE rather than one block each. The whole class of bug came from four
// copies drifting; a per-node test file would reproduce exactly that, and the next node added would
// be the one nobody remembered to cover.

const NODES = [
  { node: "noteResults", contextKey: "pursuedNotes", idField: "noteId" },
  { node: "allergyResults", contextKey: "patientAllergies", idField: "allergyId" },
  { node: "familyResults", contextKey: "patientFamilyHistory", idField: "familyId" },
  { node: "diseaseResults", contextKey: "diagnosedDisease", idField: "diseaseId" },
] as const;

const row = (idField: string, id: string) => ({ [idField]: id, result: "a result", group: "Cardiovascular Risk" });

describe.each(NODES)("$node — the response must answer the rows it was asked about", ({ node, contextKey, idField }) => {
  const spec = LEAF_REGEN_SPECS[node];
  const context = { [contextKey]: [{ id: "row-1" }, { id: "row-2" }] };
  const check = (items: Record<string, string>[]) => spec.checkAgainstInput!(context, { items });

  it("accepts one entry per row, in any order", () => {
    expect(() => check([row(idField, "row-2"), row(idField, "row-1")])).not.toThrow();
  });

  it("rejects an id that was never asked about", () => {
    expect(() => check([row(idField, "row-1"), row(idField, "row-9")])).toThrow(/row-9.*not one of the 2 rows/);
  });

  it("rejects the same id answered twice", () => {
    expect(() => check([row(idField, "row-1"), row(idField, "row-1")])).toThrow(/answered twice/);
  });

  it("rejects a row left unanswered — the skip that used to shift every later answer", () => {
    expect(() => check([row(idField, "row-1")])).toThrow(/1 of 2 rows went unanswered.*row-2/);
  });

  it("requires the id field in the payload shape, so a position-only response cannot get through", () => {
    expect(() => spec.validate({ items: [{ result: "x", group: "Cardiovascular Risk" }] })).toThrow(
      new RegExp(`${idField}, result, group`),
    );
  });

  it("declares the id as required in its tool schema", () => {
    const schema = spec.toolSchema as {
      input_schema: { properties: { items: { items: { properties: Record<string, unknown>; required: string[] } } } };
    };
    const items = schema.input_schema.properties.items.items;
    expect(items.properties).toHaveProperty(idField);
    expect(items.required).toContain(idField);
  });
});

describe("validateLeafResult is the one gate", () => {
  const context = { pursuedNotes: [{ id: "note-1" }] };

  it("runs the shape check and then the input check", () => {
    expect(() => validateLeafResult("noteResults", { items: [{ result: "x" }] }, context)).toThrow(/noteId, result, group/);
    expect(() => validateLeafResult("noteResults", { items: [row("noteId", "note-7")] }, context)).toThrow(/not one of the 1 rows/);
    expect(validateLeafResult("noteResults", { items: [row("noteId", "note-1")] }, context)).toEqual({
      items: [row("noteId", "note-1")],
    });
  });

  it("passes a node with no checkAgainstInput straight through its own validate", () => {
    // treatmentGroups, not treatmentAssessment: W71 gave the latter a checkAgainstInput, so using it
    // here would assert the opposite of what this test is named for.
    const groups = [{ system: "Cardiovascular Risk", topic: "statins", patient: [], ai: [] }];
    expect(validateLeafResult("treatmentGroups", { groups }, {})).toEqual({ groups });
  });
});

// The scoped path is where position pairing was most dangerous: a one-item response had to be paired
// against the targeted id rather than position 0 of the FULL row list, or a Translate on the second
// note overwrote the first. buildContext narrows the row list before the request, so the context's id
// set is the expected set — scoped and unscoped share one path with no separate branch.
describe("row-scoped Translate", () => {
  function clientWithTwoNotes(): Client {
    return {
      displayName: "Alex",
      dob: "1980-01-01",
      gender: "male",
      watchlist: [],
      results: [],
      factors: {
        noteEntries: [
          { id: "note-1", text: "Woke up with tingling in my left hand." },
          { id: "note-2", text: "Second note." },
        ],
      },
      finding: { disease: [{ group: "Cardiovascular Risk", finding: "x" }] },
    } as unknown as Client;
  }

  it("expects back exactly the scoped row, not the full list", () => {
    const spec = LEAF_REGEN_SPECS.noteResults;
    const scoped = leafContextFor("noteResults", clientWithTwoNotes(), ["note-2"]);
    expect((scoped.pursuedNotes as { id: string }[]).map((n) => n.id)).toEqual(["note-2"]);

    expect(() => spec.checkAgainstInput!(scoped, { items: [row("noteId", "note-2")] })).not.toThrow();
    // The unscoped answer is now WRONG for a scoped request — it answers a row this request never
    // asked about. Under position pairing this same payload silently overwrote note-1.
    expect(() => spec.checkAgainstInput!(scoped, { items: [row("noteId", "note-1")] })).toThrow(/not one of the 1 rows/);
  });

  it("merges the scoped answer onto its own row without being told which row was targeted", () => {
    const c = clientWithTwoNotes();
    c.finding!.noteResults = [{ noteId: "note-1", result: "note one's own result", group: "Cardiovascular Risk" }];
    const updated = LEAF_REGEN_SPECS.noteResults.mergeInto(c, { items: [row("noteId", "note-2")] });
    expect(updated.finding!.noteResults).toEqual([
      { noteId: "note-1", result: "note one's own result", group: "Cardiovascular Risk" },
      { noteId: "note-2", result: "a result", group: "Cardiovascular Risk" },
    ]);
  });
});

// The gate only works if BOTH paths go through it. A leaf response reaches the merge two ways — the
// in-process runLeafRegen (CLI + the Pages relay) and the browser's fetchLeafRegen — and this module
// exists because those two paths drifted before. Calling `spec.validate` directly still type-checks
// and still returns a validated result; it just silently skips every id check. That is precisely the
// regression that would reintroduce the misattribution, and no behavioural test can see it, so this
// one reads the source.
describe("both leaf paths route through validateLeafResult", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  it.each(["src/lib/leaf-regen-anthropic.ts", "src/lib/leaf-regen-client.ts"])(
    "%s calls validateLeafResult and never spec.validate directly",
    (file) => {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      expect(source).toContain("validateLeafResult(");
      expect(source).not.toMatch(/spec\.validate\s*\(/);
    },
  );
});

import { describe, it, expect } from "vitest";
import { validLeafPayload } from "../../tests/e2e/_leaf-payloads";
import { LEAF_REGEN_SPECS, validateLeafResult, leafContextFor } from "../../src/lib/leaf-regen-registry";
import type { Client } from "../../src/lib/types";

// W68 — the guard that keeps the e2e stub helper honest.
//
// A helper that builds mock payloads is only worth having if it builds VALID ones, and "valid" is
// decided by validateLeafResult, which tightens over time. So the helper's output is run through the
// real validator for every specced node. When the contract tightens again, this fails with a clear
// message instead of five e2e specs failing for reasons unrelated to what they test.
//
// The table is derived from LEAF_REGEN_SPECS, not listed: a tenth node with no builder fails here.

function client(): Client {
  return {
    displayName: "Pablo",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    factors: {
      decisions: [{ id: "d1", intervention: "Pregnenolone", purpose: "sleep" }],
      treatments: [
        { id: "t1", name: "Rosuvastatin", doseAmount: 20, doseUnit: "mg", doseFrequency: "day", start: "2025-01" },
        { id: "t2", name: "Tirzepatide", doseAmount: 9, doseUnit: "mg", doseFrequency: "week", start: "2099-06" },
      ],
      noteEntries: [
        { id: "n1", text: "first note" },
        { id: "n2", text: "second note" },
      ],
      allergies: [{ id: "al1", allergen: "Pollen", reaction: "" }],
      familyHistory: [{ id: "fh1", relation: "Mother", condition: "T2D" }],
      diseases: [{ id: "dx1", date: "2021-10", diagnostic: "CAD" }],
    },
    study: { entries: [{ id: "s1", focus: "Statin intolerance", detail: "d" }] },
    finding: {
      disease: [{ group: "Cardiovascular Risk", finding: "x" }],
      decisions: { ai: [{ intervention: "Ezetimibe", purpose: "p", pros: [], cons: [], alternatives: [], recommendation: "r" }], patient: [] },
    },
  } as unknown as Client;
}

const NODES = Object.keys(LEAF_REGEN_SPECS);

describe("the e2e leaf stub builds payloads the REAL validator accepts", () => {
  it("covers every specced node, so a new node cannot be silently unstubbed", () => {
    expect(NODES.length).toBeGreaterThanOrEqual(9);
    for (const node of NODES) {
      expect(() => validLeafPayload(node, leafContextFor(node, client()))).not.toThrow();
    }
  });

  it.each(NODES)("%s", (node) => {
    const context = leafContextFor(node, client());
    const payload = validLeafPayload(node, context);
    // The same gate the relay and the browser both run — shape AND the response-vs-input checks.
    expect(() => validateLeafResult(node, payload, context)).not.toThrow();
  });

  it("answers every row it was given — the coverage rule, not just the shape", () => {
    const context = leafContextFor("noteResults", client());
    const payload = validLeafPayload("noteResults", context) as { items: { noteId: string }[] };
    expect(payload.items.map((i) => i.noteId).sort()).toEqual(["n1", "n2"]);
  });

  it("honours a scoped request, answering only the row that was asked about", () => {
    const context = leafContextFor("noteResults", client(), ["n2"]);
    const payload = validLeafPayload("noteResults", context);
    expect(() => validateLeafResult("noteResults", payload, context)).not.toThrow();
    expect((payload as { items: unknown[] }).items).toHaveLength(1);
  });

  it("perRow lets a spec derive each answer from its own row", () => {
    const context = leafContextFor("noteResults", client());
    const payload = validLeafPayload("noteResults", context, {
      perRow: (row) => `echo<<${(row as { text: string }).text}>>`,
    }) as { items: { noteId: string; result: string }[] };
    expect(payload.items.find((i) => i.noteId === "n1")!.result).toBe("echo<<first note>>");
    expect(payload.items.find((i) => i.noteId === "n2")!.result).toBe("echo<<second note>>");
  });
});

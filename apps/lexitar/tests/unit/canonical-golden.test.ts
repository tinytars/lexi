import { describe, it, expect } from "vitest";
import golden from "../fixtures/canonical-golden.json";
import { CANONICAL_VARIANTS } from "../fixtures/canonical-variants";
import { FINDING_DAG } from "../../src/lib/finding-dag";
import { nodeInputCanonical } from "../../src/lib/node-input-hash";
import { factorsCanonicalString, findingInputsCanonicalString, attachmentsCanonical } from "../../src/lib/factors-hash";
import type { Attachment, Client } from "../../src/lib/types";

// The graph-brain extraction (docs/health-dash/plans/61-w61-graph-brain-extraction.md) repoints
// stableStringify and the DAG traversal/hashing machinery onto a generalized library. Neither
// direction of drift in a clinical Finding's staleness throws an error on its own: everything looking
// stale means needless ~$5/patient regen, but a genuinely stale Finding displaying as fresh is
// patient-facing. This test freezes the CURRENT canonical-string output (tests/fixtures/
// canonical-golden.json, generated once from pre-extraction code) and every subsequent extraction
// commit must leave it byte-for-byte unchanged. A failure here means a step that was supposed to be
// mechanical was not — regenerate the fixture ONLY for a deliberate, reviewed hashing change, never to
// make this test pass.
describe("canonical-string golden fixture (graph-brain extraction guard)", () => {
  for (const [name, build] of Object.entries(CANONICAL_VARIANTS)) {
    describe(name, () => {
      const client = build();
      const expected = (golden as Record<string, { factorsCanonical: string; findingInputsCanonical: string; nodes: Record<string, string> }>)[name];

      it("factorsCanonicalString is unchanged", () => {
        expect(factorsCanonicalString(client)).toBe(expected.factorsCanonical);
      });

      it("findingInputsCanonicalString is unchanged", () => {
        expect(findingInputsCanonicalString(client)).toBe(expected.findingInputsCanonical);
      });

      it("every DAG node's input-closure canonical string is unchanged", () => {
        for (const n of FINDING_DAG) {
          expect(nodeInputCanonical(client, n.key), n.key).toBe(expected.nodes[n.key]);
        }
      });
    });
  }
});

// W75 — attachments and ICD codes steer 8 of the 9 leaf prompts and hashed into nothing, so attaching
// a PDF to a note left every downstream answer reading FRESH: the reply the patient saw had been
// computed without the document they had just added, and no chip said so.
//
// The golden fixtures above are the other half of this test: none of their variants carries an
// attachment or an ICD code, and they still match byte-for-byte, which is the proof that folding
// these in does not mark the existing user base stale. What follows proves the fold actually bites.
describe("W75 — attachments and ICD codes steer the prompt, so they steer the hash", () => {
  const pdf = (key: string, chars?: number): Attachment => ({
    key,
    name: "report.pdf",
    mediaType: "application/pdf",
    bytes: 1024,
    addedAt: "2026-01-01T00:00:00.000Z",
    ...(chars === undefined ? {} : { extracted: { at: "2026-01-01T00:00:00.000Z", chars } }),
  });

  const withFactors = (f: Client["factors"], study?: Client["study"]): Client => ({
    displayName: "Att",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    factors: f,
    ...(study ? { study } : {}),
  });

  it("returns EMPTY for a row with no attachments — the byte-identical guarantee, at its source", () => {
    expect(attachmentsCanonical(undefined)).toBe("");
    expect(attachmentsCanonical([])).toBe("");
  });

  it("is order-independent — two devices that attached the same pair in either order agree", () => {
    expect(attachmentsCanonical([pdf("b"), pdf("a")])).toBe(attachmentsCanonical([pdf("a"), pdf("b")]));
  });

  it("moves when the text is EXTRACTED, not only when the file arrives — that is what the prompt sees", () => {
    expect(attachmentsCanonical([pdf("a")])).not.toBe(attachmentsCanonical([pdf("a", 4000)]));
  });

  // Every row type that can carry one, and the node whose slice must move for it.
  const cases: { node: string; without: Client; with: Client }[] = [
    {
      node: "pursuedNotes",
      without: withFactors({ noteEntries: [{ id: "n1", text: "Ask about statin intolerance" }] }),
      with: withFactors({ noteEntries: [{ id: "n1", text: "Ask about statin intolerance", attachments: [pdf("r1", 900)] }] }),
    },
    {
      node: "treatmentHistory",
      without: withFactors({ treatments: [{ id: "t1", name: "Ezetimibe", kind: "drug", start: "2025-01" }] }),
      with: withFactors({ treatments: [{ id: "t1", name: "Ezetimibe", kind: "drug", start: "2025-01", attachments: [pdf("r2")] }] }),
    },
    {
      node: "patientAllergies",
      without: withFactors({ allergies: [{ id: "a1", allergen: "Penicillin", reaction: "Hives" }] }),
      with: withFactors({ allergies: [{ id: "a1", allergen: "Penicillin", reaction: "Hives", attachments: [pdf("r3")] }] }),
    },
    {
      node: "patientFamilyHistory",
      without: withFactors({ familyHistory: [{ id: "f1", relation: "Father", condition: "MI at 55" }] }),
      with: withFactors({ familyHistory: [{ id: "f1", relation: "Father", condition: "MI at 55", attachments: [pdf("r4")] }] }),
    },
    {
      node: "patientHypothesis",
      without: withFactors({ decisions: [{ id: "h1", intervention: "TRT", purpose: "free T" }] }),
      with: withFactors({ decisions: [{ id: "h1", intervention: "TRT", purpose: "free T", attachments: [pdf("r5")] }] }),
    },
    {
      node: "diagnosedDisease",
      without: withFactors({ diseases: [{ id: "d1", date: "2025", diagnostic: "CAC 100" }] }),
      with: withFactors({ diseases: [{ id: "d1", date: "2025", diagnostic: "CAC 100", attachments: [pdf("r6", 120)] }] }),
    },
    {
      node: "pursuedStudy",
      without: withFactors({}, { entries: [{ id: "s1", focus: "Suspicion", detail: "CVD" }] }),
      with: withFactors({}, { entries: [{ id: "s1", focus: "Suspicion", detail: "CVD", attachments: [pdf("r7")] }] }),
    },
  ];

  for (const c of cases) {
    it(`${c.node} goes stale when a document is attached to one of its rows`, () => {
      expect(nodeInputCanonical(c.with, c.node)).not.toBe(nodeInputCanonical(c.without, c.node));
    });
  }

  it("diagnosedDisease moves when a diagnosis gains an ICD code — printed into the prompt twice", () => {
    const without = withFactors({ diseases: [{ id: "d1", date: "2025", diagnostic: "CAC 100" }] });
    const with_ = withFactors({ diseases: [{ id: "d1", date: "2025", diagnostic: "CAC 100", icdCodes: ["I25.10"] }] });
    expect(nodeInputCanonical(with_, "diagnosedDisease")).not.toBe(nodeInputCanonical(without, "diagnosedDisease"));
    // An empty list is the same as no list: a UI that writes `icdCodes: []` must not restale everyone.
    const empty = withFactors({ diseases: [{ id: "d1", date: "2025", diagnostic: "CAC 100", icdCodes: [] }] });
    expect(nodeInputCanonical(empty, "diagnosedDisease")).toBe(nodeInputCanonical(without, "diagnosedDisease"));
  });

  it("removing the attachment again returns the exact string it started with", () => {
    const c = cases[0];
    expect(nodeInputCanonical(c.without, c.node)).toBe(nodeInputCanonical(withFactors({ noteEntries: [{ id: "n1", text: "Ask about statin intolerance", attachments: [] }] }), c.node));
  });
});

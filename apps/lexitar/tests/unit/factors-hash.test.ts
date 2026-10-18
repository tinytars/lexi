import { describe, it, expect } from "vitest";
import { findingInputsHashOf, factorsHashOf, nodeHashesOf } from "../../scripts/factors";
import { findingInputsHash, isFindingStale } from "../../src/lib/staleness";
import { treatmentCanonical } from "../../src/lib/factors-hash";
import type { Client, ClientFinding, TreatmentItem, ClientFactors, LegacyFactors } from "../../src/lib/types";

type LegacyClient = Client & { factors: ClientFactors & LegacyFactors & { conditions?: { id: string; text: string; pinned?: boolean }[] } };

function sampleClient(): LegacyClient {
  return {
    displayName: "Test",
    dob: "1980-01-01",
    gender: "male",
    watchlist: ["ApoB", "hsCRP"],
    results: [
      { marker: "ApoB", group: "Lipids", source: "Blood", date: "2026-01", value: 80, unit: "mg/dL" },
      { marker: "hsCRP", group: "Inflammation", source: "Blood", date: "2026-01", value: 0.6, unit: "mg/L" },
    ],
    // W64 — `medications`/`plan` are LEGACY factor fields: types.ts declares them on LegacyFactors,
    // not ClientFactors, and treatment-normalize.ts still folds them into `treatments` for a vault
    // written before the unification. That fold is exactly why pushing to `medications` below moves
    // the hash, so the fixture keeps them and types itself the way normalizeTreatments does.
    // (`conditions` is retired outright — kept here only as an ignored-by-canonicalization field.)
    factors: {
      conditions: [{ id: "cond-1", text: "Fatty liver" }],
      diseases: [{ id: "d1", date: "2024-01", diagnostic: "Hyperlipidemia", summary: "high LDL", icdCodes: ["E78.5"] }],
      medications: [{ drug: "Enclomiphene", dose: "12.5mg", since: "2026-01" }],
      plan: [{ action: "Start TRT", date: "2026-07" }],
    },
    study: { entries: [{ id: "study-1", focus: "Suspicion", detail: "Aortic stenosis progression" }] },
  } as LegacyClient;
}

describe("staleness hash parity (browser SubtleCrypto == Node createHash)", () => {
  it("the browser finding-inputs hash matches the CLI's findingInputsHashOf", async () => {
    const c = sampleClient();
    expect(await findingInputsHash(c)).toBe(findingInputsHashOf(c));
  });

  it("changes when an authored input changes", async () => {
    const c = sampleClient();
    const before = await findingInputsHash(c);
    c.factors!.medications!.push({ drug: "Testosterone", dose: "100mg", since: "2026-08" });
    expect(await findingInputsHash(c)).not.toBe(before);
    expect(await findingInputsHash(c)).toBe(findingInputsHashOf(c));
  });
});

describe("isFindingStale", () => {
  it("is false when the Finding's inputsHash matches the current inputs", async () => {
    const c = sampleClient();
    c.finding = { inputsHash: findingInputsHashOf(c) } as ClientFinding;
    expect(await isFindingStale(c)).toBe(false);
  });

  it("is true after an authored input changes under a stamped Finding", async () => {
    const c = sampleClient();
    c.finding = { inputsHash: findingInputsHashOf(c) } as ClientFinding;
    c.factors!.plan!.push({ action: "Add omega-3", date: "2026-09" });
    expect(await isFindingStale(c)).toBe(true);
  });

  it("is false when there is no Finding", async () => {
    expect(await isFindingStale(sampleClient())).toBe(false);
  });
});

describe("factorsHashOf still gates on range-affecting factors only", () => {
  it("ignores plan changes (plan feeds the Finding, not ranges)", () => {
    const c = sampleClient();
    const before = factorsHashOf(c);
    c.factors!.plan!.push({ action: "Add omega-3", date: "2026-09" });
    expect(factorsHashOf(c)).toBe(before);
  });
});

describe("conditions hashing ignores id/pinned (M71 P7)", () => {
  it("factorsHashOf is unchanged when only a condition's id/pinned differ", () => {
    const a = sampleClient();
    const b = sampleClient();
    b.factors!.conditions = [{ id: "some-other-id", text: "Fatty liver", pinned: true }];
    expect(factorsHashOf(b)).toBe(factorsHashOf(a));
  });

  it("the patientAssessment node hash is unchanged when only a condition's id/pinned differ", () => {
    const a = sampleClient();
    const b = sampleClient();
    b.factors!.conditions = [{ id: "some-other-id", text: "Fatty liver", pinned: true }];
    expect(nodeHashesOf(b).patientAssessment).toBe(nodeHashesOf(a).patientAssessment);
  });
});

describe("notes hashing ignores id/pinned, but is order-sensitive (M92)", () => {
  it("findingInputsHashOf is unchanged when only a note's id differs", () => {
    const a = sampleClient();
    const b = sampleClient();
    a.factors!.noteEntries = [{ id: "note-1", text: "Woke up with tingling." }];
    b.factors!.noteEntries = [{ id: "some-other-id", text: "Woke up with tingling." }];
    expect(findingInputsHashOf(b)).toBe(findingInputsHashOf(a));
  });

  // W62 reverses the `pinned` half of M92's rule, deliberately. It held because a pin did nothing
  // but sort a sidebar list; a pin is now an AREA OF QUERY carried into the prompt
  // (pinned-queries.ts), so an input the model sees must be an input the hash sees. noteCanonical
  // itself still projects to text only — the pin enters through the pinnedQueries key instead, so
  // the per-note DAG slice is untouched.
  it("findingInputsHashOf DOES change when a note is pinned", () => {
    const a = sampleClient();
    const b = sampleClient();
    a.factors!.noteEntries = [{ id: "note-1", text: "Woke up with tingling." }];
    b.factors!.noteEntries = [{ id: "note-1", text: "Woke up with tingling.", pinned: true }];
    expect(findingInputsHashOf(b)).not.toBe(findingInputsHashOf(a));
  });

  it("findingInputsHashOf changes when a note's text changes", () => {
    const a = sampleClient();
    a.factors!.noteEntries = [{ id: "note-1", text: "Woke up with tingling." }];
    const before = findingInputsHashOf(a);
    a.factors!.noteEntries[0].text = "Woke up with tingling in my left hand.";
    expect(findingInputsHashOf(a)).not.toBe(before);
  });

  it("findingInputsHashOf changes when two notes are reordered (pairing is positional, so order is load-bearing)", () => {
    const a = sampleClient();
    const b = sampleClient();
    a.factors!.noteEntries = [{ id: "note-1", text: "First." }, { id: "note-2", text: "Second." }];
    b.factors!.noteEntries = [{ id: "note-2", text: "Second." }, { id: "note-1", text: "First." }];
    expect(findingInputsHashOf(b)).not.toBe(findingInputsHashOf(a));
  });

  it("the noteResults node hash is unchanged when only a note's id differs", () => {
    const a = sampleClient();
    const b = sampleClient();
    a.factors!.noteEntries = [{ id: "note-1", text: "Woke up with tingling." }];
    b.factors!.noteEntries = [{ id: "some-other-id", text: "Woke up with tingling." }];
    expect(nodeHashesOf(b).noteResults).toBe(nodeHashesOf(a).noteResults);
  });

  // W71 — `pinned` used to be lumped in with `id` here as "cosmetic". It is not: W62 made starring an
  // item steer the prompt (pinnedQueryBlock in finding-generate.ts), and added it to the COARSE
  // factors hash — but never to INPUT_SLICES, which is the one that gates per-node staleness. So
  // starring an item changed what the model was asked and marked nothing stale, and this test said
  // that was correct.
  it("but starring a note DOES invalidate it, because a pin steers the prompt", () => {
    const a = sampleClient();
    const b = sampleClient();
    a.factors!.noteEntries = [{ id: "note-1", text: "Woke up with tingling." }];
    b.factors!.noteEntries = [{ id: "note-1", text: "Woke up with tingling.", pinned: true }];
    expect(nodeHashesOf(b).noteResults).not.toBe(nodeHashesOf(a).noteResults);
  });

  it("a client with no notes keeps the same hash as before notes existed at all (backward compat)", () => {
    const withoutField = sampleClient();
    const withEmptyArray = sampleClient();
    withEmptyArray.factors!.noteEntries = [];
    expect(findingInputsHashOf(withEmptyArray)).toBe(findingInputsHashOf(withoutField));
  });
});

describe("treatmentCanonical (M104 regression — structured dose fields must be load-bearing)", () => {
  function withTreatment(t: Partial<TreatmentItem>): Client {
    const c = sampleClient();
    c.factors!.treatments = [{ id: "t1", name: "Tirzepatide", start: "2025-01", ...t } as TreatmentItem];
    return c;
  }

  it("changes when only doseAmount/doseUnit/doseFrequency change, dose left untouched (was invisible before M104)", () => {
    const before = treatmentCanonical(withTreatment({}));
    const after = treatmentCanonical(withTreatment({ doseAmount: 6, doseUnit: "mg", doseFrequency: "week" }));
    expect(after).not.toEqual(before);
  });

  it("changes when doseAmount alone is edited on an already-structured record", () => {
    const before = treatmentCanonical(withTreatment({ doseAmount: 6, doseUnit: "mg" }));
    const after = treatmentCanonical(withTreatment({ doseAmount: 10, doseUnit: "mg" }));
    expect(after).not.toEqual(before);
  });

  it("is unchanged when nothing about the treatment differs", () => {
    const a = treatmentCanonical(withTreatment({ doseAmount: 6, doseUnit: "mg", doseFrequency: "week" }));
    const b = treatmentCanonical(withTreatment({ doseAmount: 6, doseUnit: "mg", doseFrequency: "week" }));
    expect(a).toEqual(b);
  });
});

import { describe, it, expect } from "vitest";
import { removeSource, provenanceIssues, upsertSourceRecord } from "@pablotech/akesi/ingest-core";
import { isFindingStale, findingInputsHash } from "../../src/lib/staleness";
import type { Client, MarkerResult, SourceRecord, ClientFinding, TreatmentItem } from "../../src/lib/types";

function src(id: string, kind: SourceRecord["kind"] = "lab"): SourceRecord {
  return { id, sha256: id.padEnd(64, "0"), kind, file: `records/private/p/raw/${id}.x`, originalName: `${id}.x`, importedAt: "2026-01-01" };
}
function lab(marker: string, date: string, value: number, sourceId?: string): MarkerResult {
  return { marker, group: "Panel", source: "Blood", date, value, unit: "mg/dL", ...(sourceId ? { sourceId } : {}) };
}
function base(): Client {
  return { displayName: "T", dob: "1980-01-01", gender: "male", watchlist: [], results: [], factors: { diseases: [] } };
}

describe("removeSource — cascade", () => {
  it("drops the SourceRecord and every reading/disease it produced", () => {
    const c = base();
    c.sources = [src("aaaaaaaa1111"), src("bbbbbbbb2222", "imaging")];
    c.results = [
      lab("Glucose", "2026-01-01", 90, "aaaaaaaa1111"),
      lab("LDL-C", "2026-01-01", 100, "aaaaaaaa1111"),
      lab("ApoB", "2026-01-01", 80, "bbbbbbbb2222"),
    ];
    c.factors!.diseases = [
      { id: "d1", date: "2026-01-01", diagnostic: "Hyperlipidemia", sourceId: "aaaaaaaa1111" },
      { id: "d2", date: "2026-01-01", diagnostic: "Fatty liver" }, // hand-entered, no sourceId
    ];

    const res = removeSource(c, "aaaaaaaa1111");
    expect(res.removed).toBe(true);
    expect({ markers: res.markersDropped, diseases: res.diseasesDropped }).toEqual({ markers: 2, diseases: 1 });
    expect(c.sources!.map((s) => s.id)).toEqual(["bbbbbbbb2222"]);
    expect(c.results.map((r) => r.marker)).toEqual(["ApoB"]); // only the surviving source's reading
    expect(c.factors!.diseases!.map((d) => d.diagnostic)).toEqual(["Fatty liver"]); // hand-entered untouched
  });

  it("drops fromComparison placeholders tagged with the removed source", () => {
    const c = base();
    c.sources = [src("aaaaaaaa1111", "imaging")];
    c.results = [{ ...lab("Aortic gradient", "2021-10-08", 10, "aaaaaaaa1111"), fromComparison: true }];
    removeSource(c, "aaaaaaaa1111");
    expect(c.results).toHaveLength(0);
  });

  it("keeps a reading a surviving source also supplies (corroboration, re-attributed)", () => {
    const c = base();
    c.sources = [src("aaaaaaaa1111"), src("bbbbbbbb2222")];
    // The reading is owned by source A; source B's processed rows also carry it.
    c.results = [lab("Glucose", "2026-01-01", 90, "aaaaaaaa1111")];
    const survivingB = { sourceId: "bbbbbbbb2222", rows: [lab("Glucose", "2026-01-01", 90)] };

    const res = removeSource(c, "aaaaaaaa1111", [survivingB]);
    expect(res.markersDropped).toBe(1);
    expect(res.markersReattributed).toBe(1);
    expect(c.results).toHaveLength(1);
    expect(c.results[0].marker).toBe("Glucose");
    expect(c.results[0].sourceId).toBe("bbbbbbbb2222"); // now owned by the survivor
  });

  it("writes a PHI-free tombstone and does not duplicate it on re-remove", () => {
    const c = base();
    c.sources = [src("aaaaaaaa1111")];
    c.results = [lab("Glucose", "2026-01-01", 90, "aaaaaaaa1111")];
    removeSource(c, "aaaaaaaa1111", [], "2026-06-30T00:00:00.000Z");
    expect(c.removedSources).toEqual([{ sourceId: "aaaaaaaa1111", sha8: "aaaaaaaa", kind: "lab", removedAt: "2026-06-30T00:00:00.000Z" }]);
    // Re-removing (already gone) is a no-op and must not add a second tombstone.
    const again = removeSource(c, "aaaaaaaa1111");
    expect(again.removed).toBe(false);
    expect(c.removedSources).toHaveLength(1);
  });

  it("is a no-op for an absent source", () => {
    const c = base();
    c.sources = [src("aaaaaaaa1111")];
    const res = removeSource(c, "nope");
    expect(res.removed).toBe(false);
    expect(c.sources).toHaveLength(1);
    expect(c.removedSources ?? []).toHaveLength(0);
  });
});

describe("removeSource — removed ≠ stale", () => {
  it("the deleted data is gone (not flagged stale) while the Finding becomes stale", async () => {
    const c = base();
    c.sources = [src("aaaaaaaa1111")];
    c.results = [lab("Glucose", "2026-01-01", 90, "aaaaaaaa1111")];
    // Stamp a Finding with the hash of the CURRENT inputs → not stale yet.
    c.finding = { inputsHash: await findingInputsHash(c) } as ClientFinding;
    expect(await isFindingStale(c)).toBe(false);

    removeSource(c, "aaaaaaaa1111");
    // The reading is deleted outright — not retained-and-marked-stale.
    expect(c.results).toHaveLength(0);
    // The Finding's inputs shrank, so it is now stale (regen flag), a distinct state.
    expect(await isFindingStale(c)).toBe(true);
  });
});

describe("re-ingest clears the tombstone (upsertSourceRecord)", () => {
  it("removes a matching tombstone so it can't become a tombstone/live collision", () => {
    const c = base();
    c.sources = [src("aaaaaaaa1111")];
    c.results = [lab("Glucose", "2026-01-01", 90, "aaaaaaaa1111")];
    removeSource(c, "aaaaaaaa1111");
    expect(c.removedSources).toHaveLength(1);

    // Re-ingesting the same sha re-registers the source — its tombstone must clear.
    upsertSourceRecord(c, src("aaaaaaaa1111"));
    expect(c.removedSources ?? []).toHaveLength(0);
    expect(provenanceIssues(c)).toEqual([]);
  });
});

describe("provenanceIssues", () => {
  it("flags a planted orphan and passes after a clean remove", () => {
    const c = base();
    c.sources = [src("aaaaaaaa1111")];
    c.results = [lab("Glucose", "2026-01-01", 90, "aaaaaaaa1111")];
    expect(provenanceIssues(c)).toEqual([]);

    // Plant a dangling reference (source that no longer exists).
    c.results.push(lab("LDL-C", "2026-01-01", 100, "ghostghost00"));
    expect(provenanceIssues(c).some((i) => i.kind === "dangling-result")).toBe(true);

    // A clean removeSource of the real source leaves no orphan from it.
    c.results = c.results.filter((r) => r.sourceId !== "ghostghost00");
    removeSource(c, "aaaaaaaa1111");
    expect(provenanceIssues(c)).toEqual([]);
  });

  it("flags a tombstone that collides with a live source", () => {
    const c = base();
    c.sources = [src("aaaaaaaa1111")];
    c.removedSources = [{ sourceId: "aaaaaaaa1111", sha8: "aaaaaaaa", kind: "lab", removedAt: "" }];
    expect(provenanceIssues(c).some((i) => i.kind === "tombstone-live")).toBe(true);
  });

  function treatment(overrides: Partial<TreatmentItem>): TreatmentItem {
    return { id: "t1", name: "Lipitor", start: "2026-01", ...overrides };
  }

  it("flags a photo-extracted treatment with no matching raw capture attachment", () => {
    const c = base();
    c.factors!.treatments = [treatment({ extracted: { via: "photo", at: "2026-01-01" } })];
    expect(provenanceIssues(c).some((i) => i.kind === "treatment-missing-raw-capture")).toBe(true);
  });

  it("passes a photo-extracted treatment whose raw capture attachment is on file", () => {
    const c = base();
    c.factors!.treatments = [
      treatment({
        extracted: { via: "photo", at: "2026-01-01" },
        rawCaptureAttachmentKeys: ["k1"],
        attachments: [{ key: "k1", name: "bottle.jpg", mediaType: "image/jpeg", bytes: 100, addedAt: "2026-01-01" }],
      }),
    ];
    expect(provenanceIssues(c)).toEqual([]);
  });

  it("flags a text-extracted treatment with no rawCaptureText on file", () => {
    const c = base();
    c.factors!.treatments = [treatment({ extracted: { via: "text", at: "2026-01-01" } })];
    expect(provenanceIssues(c).some((i) => i.kind === "treatment-missing-raw-capture")).toBe(true);
  });

  it("passes a text-extracted treatment whose rawCaptureText is on file", () => {
    const c = base();
    c.factors!.treatments = [treatment({ extracted: { via: "text", at: "2026-01-01" }, rawCaptureText: "Lipitor 20mg tablets" })];
    expect(provenanceIssues(c)).toEqual([]);
  });

  it("passes a hand-entered treatment (no extracted flag) regardless of attachments", () => {
    const c = base();
    c.factors!.treatments = [treatment({})];
    expect(provenanceIssues(c)).toEqual([]);
  });
});

// W70 1e — deleting a report must take the AI's read of its diagnoses with it.
//
// W68 taught `removeFrom` (vault-item-ops.ts) to cascade a row deletion into the Finding, which closed
// the orphan class for notes, allergies, family history and treatments. Report deletion never went
// through that function: it goes through removeSource, which drops the report's diagnoses at step 2 via
// removeDiseasesBySourceId and never touched `finding.diseaseResults`. Nothing else prunes it either.
//
// So the AI's assessment of every diagnosis a report carried stayed keyed to ids that no longer exist —
// invisible in the UI, travelling in the vault forever, and reappearing if an id were ever reused.
// Exactly the shape finding-invariants.ts:66 flags as "matches no row on file", produced by the same
// fact being written in two tables that disagree (vault-item-ops' three-entry map vs ID_KEYED's four).
describe("removeSource — the Finding cascade", () => {
  function withDiagnosedReport(): Client {
    const c = base();
    c.sources = [src("rep11111aaaa", "imaging"), src("rep22222bbbb", "imaging")];
    c.factors!.diseases = [
      { id: "dx-1", date: "2025-01", diagnostic: "Coronary calcification", sourceId: "rep11111aaaa" },
      { id: "dx-2", date: "2025-02", diagnostic: "Hepatic steatosis", sourceId: "rep11111aaaa" },
      { id: "dx-3", date: "2025-03", diagnostic: "Thyroid nodule", sourceId: "rep22222bbbb" },
    ];
    c.finding = {
      disease: [{ group: "Cardiovascular Risk", finding: "x" }],
      diseaseResults: [
        { diseaseId: "dx-1", result: "read of dx-1", group: "Cardiovascular Risk" },
        { diseaseId: "dx-2", result: "read of dx-2", group: "Cardiovascular Risk" },
        { diseaseId: "dx-3", result: "read of dx-3", group: "Cardiovascular Risk" },
      ],
    } as unknown as ClientFinding;
    return c;
  }

  it("prunes the diseaseResults of the diagnoses it removed", () => {
    const c = withDiagnosedReport();
    removeSource(c, "rep11111aaaa", [], "2026-01-01");
    expect(c.factors!.diseases!.map((d) => d.id)).toEqual(["dx-3"]);
    expect(c.finding!.diseaseResults!.map((r) => r.diseaseId)).toEqual(["dx-3"]);
  });

  // The case that makes a naive "clear diseaseResults" wrong: another report's diagnoses must survive.
  it("leaves another report's diagnosis read untouched", () => {
    const c = withDiagnosedReport();
    removeSource(c, "rep22222bbbb", [], "2026-01-01");
    expect(c.finding!.diseaseResults!.map((r) => r.diseaseId).sort()).toEqual(["dx-1", "dx-2"]);
  });

  it("is a no-op on a Finding that has no diseaseResults", () => {
    const c = withDiagnosedReport();
    delete (c.finding as { diseaseResults?: unknown }).diseaseResults;
    expect(() => removeSource(c, "rep11111aaaa", [], "2026-01-01")).not.toThrow();
  });

  it("is a no-op when the source does not exist", () => {
    const c = withDiagnosedReport();
    removeSource(c, "nosuchsource", [], "2026-01-01");
    expect(c.finding!.diseaseResults).toHaveLength(3);
  });
});

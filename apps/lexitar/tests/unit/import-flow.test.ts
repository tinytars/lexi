import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, MarkerResult } from "../../src/lib/types";
import { healthmattersXlsx } from "../fixtures/healthmatters-workbook";
import {
  pendingRawName,
  buildPendingUpload,
  addPendingUpload,
  findPendingBySha,
  foldSource,
  classifyUpload,
} from "../../src/lib/import-flow";

const base = (): Client => ({ displayName: "Pablo", dob: "1980-01-01", gender: "male", watchlist: [], results: [] });

describe("pendingRawName", () => {
  it("is <sha8>-<sanitized name>, stripping unsafe chars", () => {
    expect(pendingRawName("abcdef0123456789", "2026 blood panel (v2).xlsx")).toBe("abcdef01-2026_blood_panel_v2_.xlsx");
  });
  it("falls back to 'upload' when the name sanitizes to empty", () => {
    expect(pendingRawName("abcdef0123456789", "***")).toBe("abcdef01-upload");
  });
});

describe("buildPendingUpload", () => {
  it("carries the id, sha, provisional file name, original name", () => {
    const u = buildPendingUpload("abcdef0123456789aa", "abcdef012345", "labs.xlsx", "2026-07-03T00:00:00Z");
    expect(u).toEqual({
      id: "abcdef012345",
      sha256: "abcdef0123456789aa",
      file: "abcdef01-labs.xlsx",
      originalName: "labs.xlsx",
      uploadedAt: "2026-07-03T00:00:00Z",
    });
  });
});

describe("addPendingUpload / findPendingBySha", () => {
  it("appends to a CLONE without mutating the input, and is idempotent by sha", () => {
    const c = base();
    const u = buildPendingUpload("sha-1", "id-1", "a.xlsx", "2026-07-03T00:00:00Z");
    const next = addPendingUpload(c, u);
    expect(c.pendingUploads).toBeUndefined(); // input untouched
    expect(next.pendingUploads).toHaveLength(1);
    expect(findPendingBySha(next, "sha-1")!.originalName).toBe("a.xlsx");

    const again = addPendingUpload(next, u); // same sha → no duplicate
    expect(again.pendingUploads).toHaveLength(1);

    const other = addPendingUpload(next, buildPendingUpload("sha-2", "id-2", "b.xls", "2026-07-03T01:00:00Z"));
    expect(other.pendingUploads).toHaveLength(2);
  });

  it("returns undefined for an unknown sha", () => {
    expect(findPendingBySha(base(), "nope")).toBeUndefined();
  });
});

describe("foldSource", () => {
  const rows: MarkerResult[] = [
    { marker: "Glucose", group: "Chemistry Panel", source: "HealthMatters", date: "2026-07-04", value: 92, unit: "mg/dL" },
    { marker: "Creatinine", group: "Chemistry Panel", source: "HealthMatters", date: "2026-07-04", value: 0.9, unit: "mg/dL" },
  ];

  it("folds parsed readings into a CLONE, mints the canonical name + SourceRecord", () => {
    const c = base();
    const res = foldSource(c, "Pablo", "abcdef0123456789aa", "abcdef012345", { kind: "lab", rows }, "xlsx", "labs.xlsx", "2026-07-04T00:00:00Z");

    expect(res.readingCount).toBe(2);
    expect(res.applied).toEqual({ added: 2, adopted: 0, updated: 0 });
    expect(res.dateStart).toBe("2026-07-04");
    expect(res.dateEnd).toBe("2026-07-04");
    expect(res.storedFile).toMatch(/^2026July04-blood-panel-abcdef01\.xlsx$/); // <date>-<type>-<subtype>-<sha8>.<ext>

    const rec = res.client.sources!.find((s) => s.id === "abcdef012345")!;
    expect(rec.kind).toBe("lab");
    expect(rec.file).toBe(`records/private/pablo/raw/${res.storedFile}`);
    expect(rec.readingCount).toBe(2);
    expect(res.client.results.map((r) => r.marker).sort()).toEqual(["Creatinine", "Glucose"]);

    // input untouched
    expect(c.results).toHaveLength(0);
    expect(c.sources).toBeUndefined();
  });

  it("adopts a provenance-less reading already on file instead of duplicating it", () => {
    const c = base();
    c.results.push({ marker: "Glucose", group: "Chemistry Panel", source: "manual", date: "2026-07-04", value: 92, unit: "mg/dL" });
    const res = foldSource(c, "Pablo", "sha", "id-1", { kind: "lab", rows }, "xlsx", "labs.xlsx", "2026-07-04T00:00:00Z");
    expect(res.applied.added).toBe(1); // Creatinine new
    expect(res.applied.adopted).toBe(1); // Glucose adopted (stamped sourceId)
    expect(res.client.results).toHaveLength(2);
  });
});

// The shared classify/dedup/fold spine used by both ImportTab.svelte and ChatTab.svelte's
// file-attach path — one set of tests covers both callers.
describe("classifyUpload", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  beforeEach(() => fetchMock.mockReset());

  // W69 — was a real panel from records/private/. classifyUpload is being tested here, not that
  // patient; the bytes only need to be a recognizable spreadsheet.
  const blobPanelBytes = () => healthmattersXlsx();

  it("folds a recognized spreadsheet into a source", async () => {
    const file = new File([blobPanelBytes()], "labs.xlsx");
    const res = await classifyUpload(base(), "Pablo", file);
    expect(res.status).toBe("source");
    if (res.status !== "source") throw new Error("expected source");
    expect(res.srcFold.readingCount).toBeGreaterThan(100);
    expect(res.storedFile).toBe(res.srcFold.storedFile);
  });

  it("queues an unrecognized spreadsheet as a pending upload instead of throwing", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "mystery.xlsx");
    const res = await classifyUpload(base(), "Pablo", file);
    expect(res.status).toBe("pending");
    if (res.status !== "pending") throw new Error("expected pending");
    expect(res.pending.upload.originalName).toBe("mystery.xlsx");
    expect(res.storedFile).toBe(res.pending.upload.file);
  });

  it("flags a byte-identical re-upload as a duplicate without re-parsing", async () => {
    const bytes = blobPanelBytes();
    const file1 = new File([bytes], "labs.xlsx");
    const first = await classifyUpload(base(), "Pablo", file1);
    if (first.status !== "source") throw new Error("expected source");

    const c = base();
    c.sources = first.srcFold.client.sources;
    const file2 = new File([bytes], "labs-again.xlsx");
    const second = await classifyUpload(c, "Pablo", file2);
    expect(second).toEqual({ status: "duplicate", existingId: first.id, kind: "source" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts and folds a PDF report via /api/extract", async () => {
    const report = {
      studyType: "Transthoracic Echocardiogram",
      diseases: [],
      comorbidities: [],
      priorComparisons: [],
      markers: [{ marker: "Aortic valve mean gradient", value: 14, unit: "mmHg", date: "2026-06-15", group: "Cardiac Imaging", confidence: 0.98 }],
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(report), { status: 200 }));
    const file = new File([new Uint8Array([1, 2, 3])], "echo.pdf");
    const res = await classifyUpload(base(), "Pablo", file);
    expect(res.status).toBe("report");
    if (res.status !== "report") throw new Error("expected report");
    expect(res.fold.studyType).toBe("Transthoracic Echocardiogram");
    expect(fetchMock).toHaveBeenCalledWith("/api/extract", expect.any(Object));
  });

  it("surfaces a failed /api/extract call as a status:error result, not a throw", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "model unavailable" }), { status: 503 }));
    const file = new File([new Uint8Array([1, 2, 3])], "echo.pdf");
    const res = await classifyUpload(base(), "Pablo", file);
    expect(res).toEqual({ status: "error", message: "model unavailable" });
  });
});

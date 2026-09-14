import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExtractionCache, writeExtractionCache } from "../../scripts/extraction-cache";
import type { ProposedReport } from "../../scripts/claude-report";

const report: ProposedReport = {
  studyType: "Transthoracic Echocardiogram",
  diseases: [{ date: "2026-06-15", diagnostic: "BAV with mild stenosis", summary: "…", confidence: 0.98 }],
  comorbidities: [],
  priorComparisons: [],
  markers: [{ marker: "Aortic valve mean gradient", value: 14, unit: "mmHg", date: "2026-06-15", group: "Cardiac Imaging", confidence: 0.98 }],
};

describe("extraction cache", () => {
  it("round-trips an extraction by sha256", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extcache-"));
    await writeExtractionCache("abc123", report, { model: "m", mode: "prod", cachedAt: "2026-06-22T00:00:00Z" }, dir);
    expect(await readExtractionCache("abc123", dir)).toEqual(report);
  });

  it("returns null for an uncached sha256", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extcache-"));
    expect(await readExtractionCache("missing", dir)).toBeNull();
  });
});

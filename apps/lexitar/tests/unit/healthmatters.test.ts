import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseReadingValue, isHealthmatters } from "../../src/lib/parsers/healthmatters";
import { parseRawFile } from "../../src/lib/parse-raw";

// Real .xlsx bytes (round-tripped through the xlsx dep), not mocks.
function xlsxBytes(aoa: unknown[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Results");
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

const HEALTHMATTERS = [
  ["Chemistry Panel", "Unit", "Reference", "2026-07-04"],
  ["Glucose", "mg/dL", "70-100", 92],
  ["Creatinine", "mg/dL", "0.7-1.3", 0.9],
];
const FOREIGN = [
  ["Widget", "Qty", "Price"],
  ["Sprocket", 3, 4.5],
];

describe("parseReadingValue", () => {
  it("passes plain numbers through with no display override", () => {
    expect(parseReadingValue(76)).toEqual({ value: 76 });
    expect(parseReadingValue("5.2")).toEqual({ value: 5.2 });
    expect(parseReadingValue("7.5")).toEqual({ value: 7.5 }); // a ratio, not a titer
  });

  it("reads a single titer as its reciprocal dilution + display text", () => {
    expect(parseReadingValue("1:80")).toEqual({ value: 80, valueText: "1:80" });
    expect(parseReadingValue("1:160")).toEqual({ value: 160, valueText: "1:160" });
  });

  it("keeps the comparator on a below-threshold titer", () => {
    // Previously parseFloat("<1:20") was NaN and the reading was dropped.
    expect(parseReadingValue("<1:20")).toEqual({ value: 20, valueText: "<1:20" });
  });

  it("takes the higher dilution of a titer range and drops trailing prose", () => {
    // Previously parseFloat("1:40 to 1:80 -- Low Antibody Level") returned 1.
    expect(parseReadingValue("1:40 to 1:80 -- Low Antibody Level"))
      .toEqual({ value: 80, valueText: "1:40 to 1:80" });
  });

  it("returns undefined for blanks and non-numeric qualitative results", () => {
    expect(parseReadingValue(null)).toBeUndefined();
    expect(parseReadingValue("")).toBeUndefined();
    expect(parseReadingValue("Negative")).toBeUndefined();
    expect(parseReadingValue("Nuclear, homogenous")).toBeUndefined();
  });
});

describe("isHealthmatters", () => {
  it("recognizes a HealthMatters export by its section-header rows", () => {
    expect(isHealthmatters(xlsxBytes(HEALTHMATTERS))).toBe(true);
  });
  it("rejects a foreign spreadsheet with no section headers", () => {
    expect(isHealthmatters(xlsxBytes(FOREIGN))).toBe(false);
  });
});

describe("parseRawFile — content-based dispatch", () => {
  it("routes a HealthMatters sheet to the lab parser", async () => {
    const { kind, rows } = await parseRawFile(xlsxBytes(HEALTHMATTERS), "xlsx");
    expect(kind).toBe("lab");
    expect(rows.map((r) => r.marker)).toContain("Glucose");
    expect(rows.every((r) => r.date === "2026-07-04")).toBe(true);
  });
  it("throws on an unrecognized spreadsheet so the caller can queue it", async () => {
    await expect(parseRawFile(xlsxBytes(FOREIGN), "xlsx")).rejects.toThrow(/unrecognized spreadsheet/);
  });
});

import { describe, it, expect } from "vitest";
import { parseRawFile } from "../../src/lib/parse-raw";
import { healthmattersXlsx, EXPECTED_READINGS } from "../fixtures/healthmatters-workbook";

// W13g: the byte-based parser (no fs in the core) parses a HealthMatters lab xlsx correctly —
// guards the path→bytes refactor, which previously had no file-parsing coverage.
//
// W69: was reading a real 12-year panel out of records/private/. This test is about the PARSER, not
// about that patient, so it now builds its own workbook (tests/fixtures/healthmatters-workbook.ts).
// The real file made an otherwise-pure test unrunnable anywhere the PHI is absent.
describe("parseRawFile (byte-based, src/lib/parse-raw)", () => {
  it("parses a HealthMatters blood-panel xlsx from bytes into lab rows", async () => {
    const { kind, rows } = await parseRawFile(healthmattersXlsx(), "xlsx");
    expect(kind).toBe("lab");
    expect(rows.length).toBeGreaterThan(100);
    // Exact, not just a floor: the fixture knows how many readings it encodes, so a parser that
    // silently drops a section or a date column fails here instead of squeaking past the floor.
    expect(rows.length).toBe(EXPECTED_READINGS);
    // Every row is a well-formed reading.
    for (const r of rows.slice(0, 50)) {
      expect(typeof r.marker).toBe("string");
      expect(r.marker.length).toBeGreaterThan(0);
      expect(/^\d{4}-\d{2}-\d{2}$/.test(r.date)).toBe(true);
      expect(typeof r.value).toBe("number");
    }
    // A known analyte from this panel is present.
    expect(rows.some((r) => /Cholesterol/i.test(r.marker))).toBe(true);
  });

  it("throws on an unsupported extension", async () => {
    await expect(parseRawFile(new Uint8Array([1, 2, 3]), "txt")).rejects.toThrow(/unsupported/);
  });
});

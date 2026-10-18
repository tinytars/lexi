import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { readSheetRows, firstSheetName, MAX_XLSX_BYTES, SpreadsheetTooLargeError } from "../../src/lib/parsers/xlsx-safe";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// W71 — `xlsx` carries two high-severity advisories with NO fix available, on the patient upload
// path. The mitigation is containment rather than a version bump, so what needs asserting is that the
// containment is actually in force: that the cap holds, and that no parser has quietly gone back to
// calling XLSX directly.

const book = (rows: unknown[][], sheetName = "Sheet1"): Uint8Array => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
};

describe("readSheetRows", () => {
  it("returns the first sheet as plain rows", () => {
    expect(readSheetRows(book([["a", "b"], [1, 2]]))).toEqual([["a", "b"], [1, 2]]);
  });

  it("hands back arrays, never the workbook — nothing with attacker-shaped keys escapes", () => {
    const rows = readSheetRows(book([["x"]]));
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) expect(Array.isArray(row)).toBe(true);
  });

  it("refuses a spreadsheet past the cap instead of parsing it", () => {
    // Oversized by construction, not by content: the point is that the cap is checked BEFORE the
    // parser is handed the bytes, which is the only part of this that mitigates the ReDoS directly.
    const huge = new Uint8Array(MAX_XLSX_BYTES + 1);
    expect(() => readSheetRows(huge)).toThrow(SpreadsheetTooLargeError);
    expect(() => firstSheetName(huge)).toThrow(SpreadsheetTooLargeError);
  });

  it("a file just under the cap is not refused for its size", () => {
    // It may still fail to parse — it is not a real workbook — but not with the size error, which is
    // what an off-by-one in the comparison would produce.
    expect(() => readSheetRows(new Uint8Array(MAX_XLSX_BYTES))).not.toThrow(SpreadsheetTooLargeError);
  });

  // NOT tested: the `if (!sheet) return []` branch for a workbook whose SheetNames[0] names a sheet
  // that is not there. SheetJS refuses to WRITE an empty workbook ("Workbook is empty"), so the only
  // way to reach it is a hand-crafted file — which is exactly the threat the guard is for, and
  // exactly what a test cannot honestly construct here. The guard stays; a test that faked its way
  // into it would be asserting the fake.

  it("firstSheetName lowercases, which is what the weight-app sniffer compares against", () => {
    expect(firstSheetName(book([["x"]], "InBody"))).toBe("inbody");
  });
});

// Source assertion, deliberately, and derived rather than quoted: the failure mode is a FIFTH call
// site appearing, which no behavioural test of the existing four can see. The list comes from the
// directory, so a new parser added tomorrow is covered without anyone remembering to add it here.
describe("the parsers do not reach past the wrapper", () => {
  const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "lib", "parsers");

  it("no parser imports xlsx directly except the wrapper itself", () => {
    const offenders = readdirSync(DIR)
      .filter((f) => f.endsWith(".ts") && f !== "xlsx-safe.ts")
      .filter((f) => /from ["']xlsx["']/.test(readFileSync(join(DIR, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

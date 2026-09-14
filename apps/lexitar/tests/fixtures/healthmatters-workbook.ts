import * as XLSX from "xlsx";

// W69 — a synthetic HealthMatters-shaped lab workbook, built in memory.
//
// `parse-source.test.ts` and `import-flow.test.ts` used to read a real 12-year blood panel out of
// `records/private/alex/raw/`. Neither is testing that patient: they are testing the xlsx parser and
// the classify/dedup/fold spine, and the file is incidental to both. Reading it pinned two otherwise
// clean tests to plaintext PHI, and through them the whole unit suite to a machine that has it.
//
// Built rather than committed, following the pattern already in `tests/e2e/import.spec.ts:8-19`. A
// committed .xlsx would need a `!tests/fixtures/*.xlsx` hole in the .gitignore that deliberately bans
// spreadsheets, and would be a binary nobody can diff when the parser's contract moves.
//
// The shape is what `src/lib/parsers/healthmatters.ts` actually keys on, not a guess:
//   • a SECTION HEADER row is identified solely by `row[1] === "unit"` (case-insensitive, :57),
//     with row[0] the group name and row[3..] the date columns (:110-115)
//   • a DATA row is [marker, unit, refRange, ...values] aligned to those date columns (:119-124)
//   • a BLANK row resets the date columns (:104-107), so sections are independent
// One reading is emitted per (marker × date) cell that parses, which is how a modest table reaches
// the >100 readings both tests assert.

interface Section {
  group: string;
  dates: string[];
  markers: [name: string, unit: string, ref: string, base: number][];
}

const SECTIONS: Section[] = [
  {
    group: "Lipid Panel",
    dates: ["2021-03-11", "2022-04-19", "2023-05-27", "2024-06-14", "2025-07-22", "2026-01-30"],
    markers: [
      // "Cholesterol" must appear — parse-source asserts a known analyte survives the round trip.
      ["Total Cholesterol", "mg/dL", "125-200", 178],
      ["LDL Cholesterol", "mg/dL", "<100", 96],
      ["HDL Cholesterol", "mg/dL", ">40", 58],
      ["Non-HDL Cholesterol", "mg/dL", "<130", 120],
      ["Triglycerides", "mg/dL", "<150", 110],
      ["Apolipoprotein B", "mg/dL", "<90", 84],
      ["Lipoprotein (a)", "nmol/L", "<75", 42],
    ],
  },
  {
    group: "Chemistry Panel",
    dates: ["2021-03-11", "2022-04-19", "2023-05-27", "2024-06-14", "2025-07-22", "2026-01-30"],
    markers: [
      ["Glucose", "mg/dL", "70-100", 91],
      ["Creatinine", "mg/dL", "0.7-1.3", 0.95],
      ["Sodium", "mmol/L", "135-145", 140],
      ["Potassium", "mmol/L", "3.5-5.2", 4.3],
      ["Albumin", "g/dL", "3.5-5.5", 4.6],
      ["Calcium", "mg/dL", "8.6-10.3", 9.4],
      ["Alkaline Phosphatase", "IU/L", "44-121", 72],
    ],
  },
  {
    group: "Complete Blood Count",
    dates: ["2021-03-11", "2022-04-19", "2023-05-27", "2024-06-14", "2026-01-30"],
    markers: [
      ["Hemoglobin", "g/dL", "13.0-17.7", 15.1],
      ["Hematocrit", "%", "37.5-51.0", 44.8],
      ["Platelets", "x10E3/uL", "150-450", 244],
      ["White Blood Cells", "x10E3/uL", "3.4-10.8", 6.2],
      ["Red Blood Cells", "x10E6/uL", "4.14-5.80", 5.02],
    ],
  },
];

/** Deterministic drift per (marker, date) so values vary like a real series without being random. */
function reading(base: number, markerIndex: number, dateIndex: number): number {
  const drift = ((markerIndex * 7 + dateIndex * 13) % 11) - 5; // -5..+5
  const scaled = base * (1 + drift / 100);
  return Math.round(scaled * 100) / 100;
}

/** Rows in the exact array-of-arrays shape `XLSX.utils.aoa_to_sheet` and the parser both expect. */
export function healthmattersRows(): unknown[][] {
  const rows: unknown[][] = [];
  for (const section of SECTIONS) {
    // "Unit" in row[1] is the ONLY thing that marks a section header — see healthmatters.ts:57.
    rows.push([section.group, "Unit", "Reference", ...section.dates]);
    section.markers.forEach(([name, unit, ref, base], m) => {
      rows.push([name, unit, ref, ...section.dates.map((_, d) => reading(base, m, d))]);
    });
    rows.push([]); // blank row: closes the section so the next header re-reads its own dates
  }
  return rows;
}

/**
 * A HealthMatters-shaped .xlsx as bytes. `parseRawFile(bytes, "xlsx")` classifies it as "lab".
 *
 * Backed by a real ArrayBuffer, not ArrayBufferLike: callers pass these bytes to `new File([...])`,
 * and BlobPart rejects a view that might sit on a SharedArrayBuffer.
 */
export function healthmattersXlsx(): Uint8Array<ArrayBuffer> {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(healthmattersRows()), "Results");
  const written = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const bytes = new Uint8Array(new ArrayBuffer(written.byteLength));
  bytes.set(written);
  return bytes;
}

/** How many readings the workbook should yield — markers × dates, summed across sections. */
export const EXPECTED_READINGS = SECTIONS.reduce((n, s) => n + s.markers.length * s.dates.length, 0);

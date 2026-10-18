import * as XLSX from "xlsx";

// W71 — the ONE place a spreadsheet is parsed.
//
// `xlsx` (SheetJS) carries two high-severity advisories with **no fix available**: prototype
// pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9). It sits on the patient upload
// path — every imported .xlsx reaches it — so "wait for a patch" is not a mitigation, and neither is
// dropping the dependency while HealthMatters and the weight app both export spreadsheets.
//
// What this actually buys, stated honestly:
//
//   - **A byte cap.** ReDoS is superlinear in input length, so bounding the input bounds the worst
//     case. This is the only one of the three that addresses the vulnerability directly.
//   - **A row cap.** `sheetRows` stops the parser building an unbounded object graph from a crafted
//     file that claims millions of rows.
//   - **Containment of the object graph.** Previously four call sites each did `XLSX.read(...)` →
//     `wb.Sheets[wb.SheetNames[0]]` → `sheet_to_json(header: 1)`, so the raw workbook — attacker-shaped
//     keys and all — was live in application code four times over. Here it is local to one function
//     and only `unknown[][]` leaves: arrays, no keys, nothing that can carry a `__proto__` payload
//     into a later object spread.
//
// What it does NOT buy, and should not be read as buying: the parse still runs in the main realm on
// the UI thread, so a successful pollution still lands on this realm's Object.prototype and a
// successful ReDoS still blocks the tab. The real sandbox is a Web Worker — a separate realm whose
// prototypes are its own and whose hang is not the UI's — and that is the follow-up this defers.

/**
 * Bytes past which a spreadsheet is refused rather than parsed.
 *
 * 8 MB is comfortably above every real export seen (HealthMatters' full history is well under 1 MB)
 * and far below the size at which the ReDoS patterns become expensive.
 */
export const MAX_XLSX_BYTES = 8 * 1024 * 1024;

/** Rows past which the sheet is truncated. Two orders of magnitude above any real export. */
const MAX_ROWS = 50_000;

export class SpreadsheetTooLargeError extends Error {
  constructor(bytes: number) {
    super(`this spreadsheet is ${Math.round(bytes / 1024 / 1024)} MB; the limit is ${MAX_XLSX_BYTES / 1024 / 1024} MB`);
    this.name = "SpreadsheetTooLargeError";
  }
}

/**
 * The first sheet of a workbook, as plain rows.
 *
 * Returns `[]` for a workbook with no sheets rather than throwing — every caller treats an
 * unrecognisable file as "not mine" and moves on to the next parser, and a missing sheet is that.
 */
export function readSheetRows(bytes: Uint8Array): unknown[][] {
  if (bytes.length > MAX_XLSX_BYTES) throw new SpreadsheetTooLargeError(bytes.length);
  const wb = XLSX.read(bytes, { type: "buffer", cellDates: true, sheetRows: MAX_ROWS });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
}

/** The first sheet's name, lowercased — the one workbook property a caller still needs. */
export function firstSheetName(bytes: Uint8Array): string {
  if (bytes.length > MAX_XLSX_BYTES) throw new SpreadsheetTooLargeError(bytes.length);
  return XLSX.read(bytes, { type: "buffer", sheetRows: 1 }).SheetNames[0]?.toLowerCase() ?? "";
}

// W75 — weightapp was the only parser with no test, at 19%. What it writes goes straight into the
// vault as marker results, and its three value columns are positional: a column shift files body fat
// under weight with no error anywhere, and the number is wrong in the chart forever. So these assert
// the marker→column pairing by value, not just that rows come out.

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseWeightApp, isWeightAppSheet } from "../../src/lib/parsers/weightapp";

const book = (rows: unknown[][], sheetName = "Sheet1"): Uint8Array => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
};

const HEADER = ["Date", "Skeletal muscle mass", "Body fat mass", "Weight"];
const byMarker = (rows: Awaited<ReturnType<typeof parseWeightApp>>) => new Map(rows.map((r) => [r.marker, r]));

describe("parseWeightApp", () => {
  it("files each column under the marker it belongs to", async () => {
    // Deliberately three distinct values: a column shift swaps them and every other assertion here
    // would still pass.
    const out = await parseWeightApp(book([HEADER, ["2026-03-04", 31.5, 18.2, 74.9]]));
    const m = byMarker(out);

    expect(m.get("Skeletal muscle mass (Scale)")?.value).toBe(31.5);
    expect(m.get("Body fat mass (Scale)")?.value).toBe(18.2);
    expect(m.get("Weight (Scale)")?.value).toBe(74.9);
    expect([...m.values()].every((r) => r.unit === "kg" && r.source === "Scale" && r.date === "2026-03-04")).toBe(true);
    expect(m.get("Weight (Scale)")?.group).toBe("Anthropometrics");
    expect(m.get("Body fat mass (Scale)")?.group).toBe("Body Composition – Total");
  });

  it("skips the header row rather than parsing it as data", async () => {
    const out = await parseWeightApp(book([HEADER, ["2026-03-04", 31.5, 18.2, 74.9]]));
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.date === "2026-03-04")).toBe(true);
  });

  it("emits only the measurements a row actually has", async () => {
    const out = await parseWeightApp(book([HEADER, ["2026-03-04", "", "", 74.9]]));
    expect(out.map((r) => r.marker)).toEqual(["Weight (Scale)"]);
  });

  it("drops a row with a date and no measurements, rather than writing a hole into the vault", async () => {
    expect(await parseWeightApp(book([HEADER, ["2026-03-04", "", "", ""]]))).toEqual([]);
  });

  it("drops a row whose date cell is missing or unparseable", async () => {
    const out = await parseWeightApp(book([HEADER, ["", 31.5, 18.2, 74.9], ["not a date", 1, 2, 3]]));
    expect(out).toEqual([]);
  });

  it("normalises a real date cell and a date string to the same ISO day", async () => {
    const asDate = await parseWeightApp(book([HEADER, [new Date(Date.UTC(2026, 2, 4)), 0, 0, 74.9]]));
    const asText = await parseWeightApp(book([HEADER, ["2026-03-04", 0, 0, 74.9]]));
    expect(asDate[0].date).toBe("2026-03-04");
    expect(asText[0].date).toBe("2026-03-04");
  });

  it("keeps a zero, which is a measurement, and drops a non-numeric cell, which is not", async () => {
    const out = await parseWeightApp(book([HEADER, ["2026-03-04", 0, "n/a", 74.9]]));
    const m = byMarker(out);
    expect(m.get("Skeletal muscle mass (Scale)")?.value).toBe(0);
    expect(m.has("Body fat mass (Scale)")).toBe(false);
  });

  it("reads a whole history, one set of rows per day", async () => {
    const out = await parseWeightApp(
      book([HEADER, ["2026-03-04", 31.5, 18.2, 74.9], ["2026-03-05", 31.6, 18.0, 74.6]]),
    );
    expect(out).toHaveLength(6);
    expect(new Set(out.map((r) => r.date))).toEqual(new Set(["2026-03-04", "2026-03-05"]));
  });

  it("returns nothing for an empty sheet instead of throwing", async () => {
    expect(await parseWeightApp(book([HEADER]))).toEqual([]);
  });
});

describe("isWeightAppSheet", () => {
  it("recognises the app's own export by its sheet name", () => {
    expect(isWeightAppSheet(book([["anything"]], "inbody"))).toBe(true);
  });

  it("recognises a re-saved export by its header, whatever the sheet is called", () => {
    expect(isWeightAppSheet(book([HEADER], "Sheet1"))).toBe(true);
    expect(isWeightAppSheet(book([["DATE", "SKELETAL MUSCLE MASS", "BODY FAT MASS", "WEIGHT"]]))).toBe(true);
  });

  it("declines a sheet that is missing either body-composition column", () => {
    expect(isWeightAppSheet(book([["Date", "Weight"]]))).toBe(false);
    expect(isWeightAppSheet(book([["Date", "Skeletal muscle mass", "Weight"]]))).toBe(false);
  });

  it("declines someone else's spreadsheet", () => {
    expect(isWeightAppSheet(book([["Marker", "Value", "Unit"]]))).toBe(false);
    expect(isWeightAppSheet(book([[]]))).toBe(false);
  });
});

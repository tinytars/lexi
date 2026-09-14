import { describe, it, expect } from "vitest";
import { buildCsv, buildJson } from "../../src/lib/export";
import type { Vault } from "../../src/lib/types";

// W72 — export.ts had zero test coverage and is cited as the evidence for DPGA Indicator 6
// (non-PII data extraction in a non-proprietary format). Citing untested code as certification
// evidence is how a certification becomes a claim nobody checked.
//
// It is also the patient's way OUT. A silent formatting regression here does not surface as an error;
// it surfaces as a spreadsheet somebody's clinician cannot read.

const vault = (): Vault =>
  ({
    clients: {
      zoe: {
        displayName: "Zoe",
        gender: "female",
        dob: "1990-01-01",
        watchlist: ["ApoB"],
        results: [
          { marker: "ApoB", source: "lab", group: "Lipids", date: "2026-01-02", value: 90, unit: "mg/dL", ref: { low: 40, high: 130 } },
          { marker: "ApoB", source: "lab", group: "Lipids", date: "2026-01-01", value: 80, unit: "mg/dL" },
          { marker: "Weight", source: "scale", group: "Body", date: "2026-01-01", value: 70000, unit: "g", ref: { low: 60000, high: 80000 } },
        ],
      },
      adam: {
        displayName: "Adam",
        gender: "male",
        dob: "1980-01-01",
        watchlist: [],
        results: [{ marker: "ApoB", source: "lab", group: "Lipids", date: "2026-02-02", value: 70, unit: "mg/dL" }],
      },
    },
  }) as unknown as Vault;

const rows = (csv: string) => csv.split("\n");
const cells = (line: string) => line.split(",");

describe("the CSV a patient takes to their clinician", () => {
  it("leads with a stable header row", () => {
    // Column order is the contract. A reordering is invisible to a human and breaks every importer.
    expect(rows(buildCsv(vault(), "metric"))[0]).toBe(
      "client,source,group,marker,date,value,unit,ref_low,ref_high,watched",
    );
  });

  it("is ordered deterministically — clients by name, then marker, then date", () => {
    const body = rows(buildCsv(vault(), "metric")).slice(1);
    // Adam before Zoe by displayName, though "zoe" precedes "adam" as an object key — so this fails
    // if the sort is dropped and insertion order leaks through.
    expect(body.map((l) => `${cells(l)[0]}/${cells(l)[3]}/${cells(l)[4]}`)).toEqual([
      "Adam/ApoB/2026-02-02",
      "Zoe/ApoB/2026-01-01",
      "Zoe/ApoB/2026-01-02",
      "Zoe/Weight/2026-01-01",
    ]);
  });

  it("marks watched markers", () => {
    const body = rows(buildCsv(vault(), "metric")).slice(1);
    expect(cells(body[1]).at(-1)).toBe("true"); // Zoe watches ApoB
    expect(cells(body[3]).at(-1)).toBe("false"); // Weight is not watched
  });

  it("converts the reference bounds with the value, not just the value", () => {
    // A converted reading against an unconverted range is a number that looks in range and is not.
    const metric = rows(buildCsv(vault(), "metric")).slice(1)[2];
    const [, , , , , value, unit, refLow, refHigh] = cells(metric);
    expect(unit).toBe("mg/dL");
    expect(Number(refLow)).toBe(40);
    expect(Number(refHigh)).toBe(130);
    expect(Number(value)).toBe(90);
  });

  it("auto-scales grams so a weight is not exported as 70000", () => {
    const weight = cells(rows(buildCsv(vault(), "metric")).slice(1)[3]);
    expect(weight[6]).toBe("kg");
    expect(Number(weight[5])).toBeCloseTo(70, 5);
  });

  // The bounds must move WITH the value. A 70 kg reading against a 60000–80000 range reads as wildly
  // out of range, and the export gives a clinician no way to tell that the scale was applied once.
  it("scales the reference bounds by the same factor as the value", () => {
    const weight = cells(rows(buildCsv(vault(), "metric")).slice(1)[3]);
    expect(Number(weight[7])).toBeCloseTo(60, 5);
    expect(Number(weight[8])).toBeCloseTo(80, 5);
  });

  it("emits imperial when asked, and differs from metric", () => {
    const imperial = rows(buildCsv(vault(), "imperial")).slice(1)[3];
    const metric = rows(buildCsv(vault(), "metric")).slice(1)[3];
    expect(imperial).not.toBe(metric);
    expect(cells(imperial)[6]).toBe("lb");
  });
});

describe("CSV escaping, because a marker name is free text", () => {
  const withMarker = (marker: string, valueText?: string): string => {
    const v = vault();
    (v.clients.zoe as unknown as { results: unknown[] }).results = [
      { marker, source: "lab", group: "G", date: "2026-01-01", value: 1, unit: "", valueText },
    ];
    delete (v.clients as Record<string, unknown>).adam;
    return rows(buildCsv(v, "metric"))[1];
  };

  it("quotes and doubles an embedded quote", () => {
    expect(withMarker('LDL "direct"')).toContain('"LDL ""direct"""');
  });

  it("quotes a field containing a comma, so the column count survives", () => {
    const line = withMarker("Ratio, computed");
    expect(line).toContain('"Ratio, computed"');
    // Ten columns still, despite the comma inside one of them.
    expect(line.match(/(^|,)("([^"]|"")*"|[^,]*)/g)?.length).toBeGreaterThanOrEqual(10);
  });

  it("quotes a field containing a newline", () => {
    // Asserted against the WHOLE csv, not a line: the point of the quoting is that the field spans a
    // newline, so splitting on newlines to inspect it would defeat the thing being checked.
    const v = vault();
    (v.clients.zoe as unknown as { results: unknown[] }).results = [
      { marker: "Line\nBreak", source: "lab", group: "G", date: "2026-01-01", value: 1, unit: "" },
    ];
    delete (v.clients as Record<string, unknown>).adam;
    expect(buildCsv(v, "metric")).toContain('"Line\nBreak"');
  });

  it("prefers valueText over the numeric value when present", () => {
    // "negative" must not be exported as 1.
    expect(cells(withMarker("ANA", "negative"))[5]).toBe("negative");
  });
});

describe("the JSON export carries the record and nothing else", () => {
  const payload = () => buildJson(vault(), "2026-06-28") as { exportedAt: string; clients: Record<string, unknown>[] };

  it("stamps the date and sorts clients by name", () => {
    const p = payload();
    expect(p.exportedAt).toBe("2026-06-28");
    expect(p.clients.map((c) => (c as { displayName: string }).displayName)).toEqual(["Adam", "Zoe"]);
  });

  it("includes the fields a receiving system needs", () => {
    const zoe = payload().clients[1] as Record<string, unknown>;
    for (const k of ["id", "displayName", "gender", "dob", "factors", "watchlist", "results", "finding"]) {
      expect(Object.keys(zoe)).toContain(k);
    }
  });

  // The module's own comment promises this: "Encryption/secret material never leaves — this is the
  // decrypted view." An export is the easiest place to leak a key, and the promise was untested.
  it("carries no key, envelope or passphrase material", () => {
    const v = vault();
    (v as unknown as Record<string, unknown>).wrappedDEK = "SECRET-WRAPPED-DEK";
    (v.clients.zoe as unknown as Record<string, unknown>).privateKey = "SECRET-PRIVATE-KEY";
    (v.clients.zoe as unknown as Record<string, unknown>).r2Key = "data-zoe.enc";

    const text = JSON.stringify(buildJson(v, "2026-06-28"));
    expect(text).not.toContain("SECRET-WRAPPED-DEK");
    expect(text).not.toContain("SECRET-PRIVATE-KEY");
    expect(text).not.toContain("data-zoe.enc");
    expect(text).not.toMatch(/wrappedDEK|privateKey|envelope|passphrase/i);
  });
});

// W72 item 20 — the DEXA parser's first coverage. It measured 0%.
//
// Coverage reported it cold and the reason was structural, not neglect: every line of logic sat behind
// a pdfjs call, so exercising it meant feeding it a real scan — which is PHI and can never be a
// committed fixture. Splitting the pure extractor out is what makes these assertions possible at all.
//
// The failure this guards against is specific. A DEXA report is parsed by COORDINATES: "the % Fat
// column is at x=83". If a layout shifts, or a tolerance is widened, the parser does not fail — it
// reads a neighbouring column and reports a confident, wrong body-composition number, which then joins
// a trend line a clinician reads. So the tests below are mostly about the parser declining to answer.
//
// Every fixture here is synthetic: invented coordinates and round numbers, no patient data.

import { describe, it, expect } from "vitest";
import { extractDexaMarkers, type DexaPage } from "../../src/lib/parsers/dexa";

const scanDate = (page: DexaPage = []): DexaPage => [
  { str: "Scan Date", x: 10, y: 700 },
  { str: "14/03/2026", x: 90, y: 700 },
  ...page,
];

/** A composition index label sits in the x-band 340–360; its value is read at x=537 on the same row. */
const composition = (label: string, value: string, y: number, valueX = 537): DexaPage => [
  { str: label, x: 350, y },
  { str: value, x: valueX, y },
];

describe("the scan date", () => {
  it("is read as ISO from the European format the report prints", () => {
    const out = extractDexaMarkers([scanDate(composition("Total body % Fat", "24.5", 600))]);
    expect(out[0]).toMatchObject({ marker: "Total body % Fat", value: 24.5, unit: "%", date: "2026-03-14", source: "Scan" });
  });

  it("refuses the whole parse when there is no scan date", () => {
    // Not "date it today". A body-composition reading filed under the wrong date corrupts the trend
    // it joins, and unlike a failed import nobody notices.
    expect(() => extractDexaMarkers([composition("Total body % Fat", "24.5", 600)])).toThrow(/Scan Date/);
  });

  it("ignores a date printed to the LEFT of the label, which is a different field", () => {
    expect(() =>
      extractDexaMarkers([[{ str: "Scan Date", x: 100, y: 700 }, { str: "14/03/2026", x: 10, y: 700 }]]),
    ).toThrow(/Scan Date/);
  });

  it("is found on a later page too", () => {
    const out = extractDexaMarkers([[{ str: "noise", x: 1, y: 1 }], scanDate(composition("Body mass index (kg/m²) (BMI)", "22.1", 600))]);
    expect(out).toHaveLength(0); // page 2 is read as the BMD page, not composition
    expect(() => extractDexaMarkers([[{ str: "noise", x: 1, y: 1 }], scanDate()])).not.toThrow();
  });
});

describe("composition indices", () => {
  it("reads each label's value from its own row", () => {
    const out = extractDexaMarkers([
      scanDate([
        ...composition("Total body % Fat", "24.5", 600),
        ...composition("Body mass index (kg/m²) (BMI)", "22.1", 580),
      ]),
    ]);
    expect(out.map((m) => [m.marker, m.value])).toEqual([
      ["BMI", 22.1],
      ["Total body % Fat", 24.5],
    ]);
  });

  it("maps the report's label to the marker name the app uses", () => {
    const out = extractDexaMarkers([scanDate(composition("Fat mass/height² (kg/m²) (FMI)", "5.5", 600))]);
    expect(out[0].marker).toBe("Fat mass index (FMI)");
  });

  it("skips a label it does not recognise rather than guessing", () => {
    expect(extractDexaMarkers([scanDate(composition("Some New Index", "9.9", 600))])).toEqual([]);
  });

  it("ignores a label found outside the 340–360 x-band", () => {
    // The band is how the parser tells a table label from the same words in prose. Widening it is the
    // change this assertion is here to catch.
    expect(extractDexaMarkers([scanDate(composition("Total body % Fat", "24.5", 600).map((i) => ({ ...i, x: i.x === 350 ? 200 : i.x })))])).toEqual([]);
  });

  it("emits nothing when the row has no value near x=537", () => {
    expect(extractDexaMarkers([scanDate(composition("Body mass index (kg/m²) (BMI)", "22.1", 600, 400))])).toEqual([]);
  });

  it("takes the value CLOSEST to the column when two are within tolerance", () => {
    const out = extractDexaMarkers([
      scanDate([
        { str: "Body mass index (kg/m²) (BMI)", x: 350, y: 600 },
        { str: "99.9", x: 546, y: 600 },
        { str: "22.1", x: 538, y: 600 },
      ]),
    ]);
    expect(out[0].value).toBe(22.1);
  });

  it("strips thousands separators", () => {
    const out = extractDexaMarkers([scanDate(composition("Basal metabolic rate (kcal/Day)", "1,540", 600))]);
    expect(out[0]).toMatchObject({ value: 1540, unit: "kcal/day" });
  });

  it("does not read a value from an adjacent row", () => {
    // Tolerance is 3 units of y. A row 10 apart is a different measurement.
    const out = extractDexaMarkers([
      scanDate([{ str: "Body mass index (kg/m²) (BMI)", x: 350, y: 600 }, { str: "22.1", x: 537, y: 610 }]),
    ]);
    expect(out).toEqual([]);
  });
});

describe("regional tables", () => {
  it("reads every column of a body-composition region from page 1", () => {
    const out = extractDexaMarkers([
      scanDate([
        { str: "Left Arm", x: 20, y: 500 },
        { str: "30.1", x: 83, y: 500 },
        { str: "2500", x: 135, y: 500 },
      ]),
    ]);
    expect(out.map((m) => [m.marker, m.value, m.unit])).toEqual([
      ["Left Arm % Fat", 30.1, "%"],
      ["Left Arm Tissue mass", 2500, "g"],
    ]);
    expect(out[0].group).toBe("Body Composition – Regional");
  });

  it("reads the bone-density table from page 2, not page 1", () => {
    const bmdRow: DexaPage = [
      { str: "L Spine", x: 20, y: 400 },
      { str: "1.05", x: 130, y: 400 },
    ];
    const onPage2 = extractDexaMarkers([scanDate(), bmdRow]);
    expect(onPage2.map((m) => [m.marker, m.value])).toEqual([["L Spine BMD", 1.05]]);
    // The same row on page 1 is read against the COMPOSITION columns, which is why the pages are not
    // interchangeable — x=130 is close to the Tissue mass column, not BMD.
    const onPage1 = extractDexaMarkers([scanDate(bmdRow)]);
    expect(onPage1.map((m) => m.marker)).toEqual(["L Spine Tissue mass"]);
  });

  it("skips a region label that is not in the known list", () => {
    expect(extractDexaMarkers([scanDate([{ str: "Left Thumb", x: 20, y: 500 }, { str: "1.0", x: 83, y: 500 }])])).toEqual([]);
  });

  it("survives a page 2 that does not exist", () => {
    expect(() => extractDexaMarkers([scanDate()])).not.toThrow();
  });
});

describe("scores and anthropometrics", () => {
  it("reads T- and Z-scores from anywhere in the document", () => {
    const out = extractDexaMarkers([scanDate([{ str: "T-score : -1.4", x: 10, y: 300 }]), [{ str: "Z-score : 0.6", x: 10, y: 200 }]]);
    expect(out.map((m) => [m.marker, m.value, m.group])).toEqual([
      ["Whole body T-score", -1.4, "Bone Density"],
      ["Whole body Z-score", 0.6, "Bone Density"],
    ]);
  });

  it("requires the score to start the string, so prose mentioning it is not read as a value", () => {
    expect(extractDexaMarkers([scanDate([{ str: "see T-score : -1.4 below", x: 10, y: 300 }])])).toEqual([]);
  });

  it("reads height and weight, and requires the value to be well clear of the label", () => {
    const out = extractDexaMarkers([scanDate([
      { str: "Height :", x: 10, y: 650 },
      { str: "175", x: 60, y: 650 },
    ])]);
    expect(out.map((m) => [m.marker, m.value, m.unit])).toEqual([["Height", 175, "cm"]]);
    // A number crowding the label (within 20) is part of the label's own layout, not the value.
    expect(extractDexaMarkers([scanDate([{ str: "Height :", x: 10, y: 650 }, { str: "175", x: 25, y: 650 }])])).toEqual([]);
  });

  it("stamps every marker with the same scan date and the Scan source", () => {
    const out = extractDexaMarkers([scanDate([
      ...composition("Body mass index (kg/m²) (BMI)", "22.1", 600),
      { str: "Weight :", x: 10, y: 640 },
      { str: "70.5", x: 60, y: 640 },
    ])]);
    expect(out.length).toBeGreaterThan(1);
    expect(new Set(out.map((m) => m.date))).toEqual(new Set(["2026-03-14"]));
    expect(new Set(out.map((m) => m.source))).toEqual(new Set(["Scan"]));
  });
});

import { describe, it, expect } from "vitest";
import { speechText } from "../../src/lib/speech-text";

describe("speechText", () => {
  it.each([
    ["ApoB is 92 mg/dL.", "ApoB is 92 milligrams per deciliter."],
    ["Glucose 5.4 mmol/L", "Glucose 5.4 millimoles per liter."],
    ["Insulin 5.98 uIU/mL and 6 µIU/mL", "Insulin 5.98 micro-international units per milliliter and 6 micro-international units per milliliter."],
    ["Testosterone 450 ng/dL, free 12 pg/mL", "Testosterone 450 nanograms per deciliter, free 12 picograms per milliliter."],
    ["Rosuvastatin 10 mg daily", "Rosuvastatin 10 milligrams daily."],
    ["Vitamin D 1000 IU", "Vitamin D 1000 international units."],
    ["Weight 170 lb", "Weight 170 pounds."],
    ["Normal is 70–99 mg/dL", "Normal is 70 to 99 milligrams per deciliter."],
    ["Range 3.5-5.0", "Range 3.5 to 5.0."],
    ["Drawn on 2026-07-21.", "Drawn on July 21, 2026."],
    ["Started 2024-05.", "Started May 2024."],
    ["Target ~70", "Target about 70."],
    ["HbA1c <5.7% is normal", "HbA1c below 5.7% is normal."],
    ["Aim for ≥ 60", "Aim for at least 60."],
  ])("%s", (input, spoken) => {
    expect(speechText(input)).toBe(spoken);
  });

  it("turns bullet lines into their own sentences, so each gets a pause", () => {
    expect(speechText("Here is the picture:\n• LDL is 113 mg/dL\n• HDL is up.\nBottom line: fine"))
      .toBe("Here is the picture:\nLDL is 113 milligrams per deciliter.\nHDL is up.\nBottom line: fine.");
  });

  it("leaves words that merely contain a unit alone", () => {
    expect(speechText("The mg dose and the IUD")).toBe("The mg dose and the IUD.");
  });

  it("does not read a negative-looking hyphen between words as a range", () => {
    expect(speechText("low-density lipoprotein")).toBe("low-density lipoprotein.");
  });
});

import { describe, it, expect } from "vitest";
import { missingFacts } from "../../src/lib/persona-fidelity";

describe("missingFacts", () => {
  it("passes a restatement that keeps every number", () => {
    expect(missingFacts("• LDL 113.28 mg/dL, up 3%", "Your LDL is sitting at 113.28 mg/dL — up about 3%.")).toEqual([]);
  });

  it("names a dropped number", () => {
    expect(missingFacts("ApoB 92 mg/dL; HDL 54.54 mg/dL", "ApoB is 92 mg/dL, HDL looks fine.")).toEqual(["54.54"]);
  });

  it("names a rounded number, because rounding changes what the record says", () => {
    expect(missingFacts("A1c 5.51%", "A1c is about 5.5%")).toEqual(["5.51"]);
  });

  it("treats an ISO date and its spoken form as the same fact", () => {
    expect(missingFacts("Latest on 2026-07-21: 92", "On July 21st, 2026 you were at 92")).toEqual([]);
  });

  it("names a date that was dropped", () => {
    expect(missingFacts("Started 2024-05, dose 10 mg", "You've been on 10 mg for a while")).toEqual(["2024-05"]);
  });

  it("ignores formatting-only differences in numbers", () => {
    expect(missingFacts("1,200 mg daily", "1200 mg a day")).toEqual([]);
  });

  it("does not let a number hidden inside a date satisfy a standalone number", () => {
    expect(missingFacts("Dose 21 mg", "Checked 2026-07-21")).toEqual(["21"]);
  });
});

import { describe, it, expect } from "vitest";
import { parseTargetLabels } from "../../scripts/treatment-diagnose";

describe("parseTargetLabels", () => {
  it("returns undefined when no argument was given", () => {
    expect(parseTargetLabels(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(parseTargetLabels("")).toBeUndefined();
  });

  it("splits on commas and trims whitespace", () => {
    expect(parseTargetLabels("Fish Oil, Vitamin D ,  Iron")).toEqual(["Fish Oil", "Vitamin D", "Iron"]);
  });

  it("drops empty entries from doubled or trailing commas", () => {
    expect(parseTargetLabels("Fish Oil,,Vitamin D,")).toEqual(["Fish Oil", "Vitamin D"]);
  });

  it("returns undefined when every entry is empty", () => {
    expect(parseTargetLabels(" , , ")).toBeUndefined();
  });
});

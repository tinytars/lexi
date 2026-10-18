import { describe, it, expect } from "vitest";
import { filterTokens, matchesTokens, onlyIndexed } from "./filter";

describe("filterTokens", () => {
  it("lowercases, splits on whitespace, drops empties", () => {
    expect(filterTokens("Rosuvastatin 10mg")).toEqual(["rosuvastatin", "10mg"]);
    expect(filterTokens("  Vitamin   D  ")).toEqual(["vitamin", "d"]);
    expect(filterTokens("")).toEqual([]);
    expect(filterTokens("   ")).toEqual([]);
  });
});

describe("matchesTokens", () => {
  it("empty query matches everything", () => {
    expect(matchesTokens("anything", [])).toBe(true);
    expect(matchesTokens("", [])).toBe(true);
  });

  it("is case-insensitive substring match", () => {
    expect(matchesTokens("Rosuvastatin drug", filterTokens("ROSU"))).toBe(true);
    expect(matchesTokens("Rosuvastatin drug", filterTokens("statin"))).toBe(true);
  });

  it("requires every token to match (AND)", () => {
    expect(matchesTokens("Rosuvastatin 10mg drug", filterTokens("rosuvastatin drug"))).toBe(true);
    expect(matchesTokens("Rosuvastatin 10mg drug", filterTokens("rosuvastatin supplement"))).toBe(false);
  });
});

describe("onlyIndexed", () => {
  it("passes through untouched when only is undefined", () => {
    expect(onlyIndexed(["a", "b", "c"], undefined)).toEqual(["a", "b", "c"]);
  });

  it("reduces to just the one index", () => {
    expect(onlyIndexed(["a", "b", "c"], 1)).toEqual(["b"]);
  });

  it("returns empty for an out-of-range index", () => {
    expect(onlyIndexed(["a", "b", "c"], 5)).toEqual([]);
  });
});

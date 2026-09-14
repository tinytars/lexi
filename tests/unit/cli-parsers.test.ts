import { describe, it, expect } from "vitest";
import { parseTreatment, parseDisease, parseDecision, parseStudy } from "../../scripts/cli-parsers";

describe("parseTreatment", () => {
  it("parses Name|Dose|Kind|Start|End with ISO-normalized dates", () => {
    expect(parseTreatment("Ezetimibe|10mg|drug|January 2024", "--add-treatment")).toEqual({
      name: "Ezetimibe",
      dose: "10mg",
      kind: "drug",
      start: "2024-01",
    });
  });

  it("treats a bare name as an ongoing behavior-less drug (dose/kind/dates optional)", () => {
    expect(parseTreatment("10k steps/day||behavior", "--x")).toEqual({
      name: "10k steps/day",
      kind: "behavior",
      start: "",
    });
  });

  it("captures an End date (discontinued)", () => {
    expect(parseTreatment("Metformin|500mg|drug|2023-01|2024-06", "--x")).toEqual({
      name: "Metformin",
      dose: "500mg",
      kind: "drug",
      start: "2023-01",
      end: "2024-06",
    });
  });

  it("rejects a bad kind", () => {
    expect(() => parseTreatment("Foo|1mg|potion|2024-01", "--x")).toThrow(/kind must be one of/);
  });

  it("rejects missing pipes", () => {
    expect(() => parseTreatment("just-a-drug", "--x")).toThrow(/Name\|Dose\|Kind\|Start\|End/);
  });

  it("rejects empty name", () => {
    expect(() => parseTreatment("|dose|drug", "--x")).toThrow(/Name\|Dose\|Kind\|Start\|End/);
  });
});

describe("parseDisease", () => {
  it("splits on the first pipe (so diagnostic can contain pipes)", () => {
    expect(parseDisease("2019|NAFLD | mild", "--add-disease")).toEqual({
      date: "2019",
      diagnostic: "NAFLD | mild",
    });
  });

  it("rejects missing pipe", () => {
    expect(() => parseDisease("2019", "--x")).toThrow();
  });

  it("rejects empty date", () => {
    expect(() => parseDisease("|NAFLD", "--x")).toThrow();
  });

  it("rejects empty diagnostic", () => {
    expect(() => parseDisease("2019|", "--x")).toThrow();
  });
});

describe("parseStudy", () => {
  it("parses Focus|Detail, splitting on the first pipe", () => {
    expect(parseStudy("Selection|identify a statin | muscle-sparing", "--add-study")).toEqual({
      focus: "Selection",
      detail: "identify a statin | muscle-sparing",
    });
  });

  it("rejects missing pipe / empty halves", () => {
    expect(() => parseStudy("Selection", "--x")).toThrow(/Focus\|Detail/);
    expect(() => parseStudy("|detail", "--x")).toThrow(/Focus\|Detail/);
    expect(() => parseStudy("Selection|", "--x")).toThrow(/Focus\|Detail/);
  });
});

describe("parseDecision", () => {
  it("parses Intervention|Purpose", () => {
    expect(parseDecision("TRT|improved free T", "--add-decision")).toEqual({
      intervention: "TRT",
      purpose: "improved free T",
    });
  });

  it("splits on first pipe", () => {
    expect(parseDecision("Foo|Bar | baz", "--x")).toEqual({
      intervention: "Foo",
      purpose: "Bar | baz",
    });
  });

  it("rejects missing pipe", () => {
    expect(() => parseDecision("TRT only", "--x")).toThrow();
  });

  it("rejects empty purpose", () => {
    expect(() => parseDecision("TRT|", "--x")).toThrow();
  });
});

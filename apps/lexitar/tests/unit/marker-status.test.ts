import { describe, it, expect } from "vitest";
import { statusWord, chartLabel } from "../../src/lib/marker-status";

// W71 — these replace the source-text assertions in a11y-static.test.ts, which checked that
// MarkerChart.svelte CONTAINED the string "out of range" and `aria-label={chartLabel}`. Those pass
// for a component that renders the word into a `display: none` element and fail for a rename that
// changes nothing a patient experiences. What a blind patient actually hears is a value, so it can be
// asserted as one.

describe("a marker's status is available as a word, not only as a colour", () => {
  it.each([
    ["danger", "out of range"],
    ["warn", "watch"],
    ["safe", "in range"],
  ])("%s reads as %s", (status, word) => {
    expect(statusWord(status)).toBe(word);
  });

  it("says nothing at all for a marker with no range to judge against", () => {
    // Not "unknown": read aloud after every unranged marker that is noise, not information.
    expect(statusWord("none")).toBe("");
    expect(statusWord("")).toBe("");
  });

  it("the three words are distinct, so the distinction survives being spoken", () => {
    const words = ["danger", "warn", "safe"].map(statusWord);
    expect(new Set(words).size).toBe(3);
  });

  // The whole point of WCAG 1.4.1 here: a reader who cannot see the border colour still learns the
  // status. A word that merely repeats the marker name would satisfy a source grep and not this.
  it("no status word is empty except the no-opinion case", () => {
    for (const s of ["danger", "warn", "safe"]) expect(statusWord(s).trim().length).toBeGreaterThan(0);
  });
});

describe("the chart's accessible name carries the reading, not just the marker name", () => {
  // role="img" makes the SVG's internals inert to assistive tech, so this string is ALL a screen
  // reader gets. It used to be the marker's name and nothing else.
  it("carries name, value, unit, status and date", () => {
    const label = chartLabel({ name: "ApoB", value: "90", unit: "mg/dL", status: "danger", date: "2026-01-01" });
    expect(label).toContain("ApoB");
    expect(label).toContain("90");
    expect(label).toContain("mg/dL");
    expect(label).toContain("out of range");
    expect(label).toContain("2026-01-01");
  });

  it("reads as a sentence rather than a data grid", () => {
    expect(chartLabel({ name: "ApoB", value: "90", unit: "mg/dL", status: "safe", date: "2026-01-01" })).toBe(
      "ApoB: 90 mg/dL, in range, as of 2026-01-01",
    );
  });

  it("says so plainly when there are no readings", () => {
    expect(chartLabel({ name: "Lp(a)", status: "none" })).toBe("Lp(a): no readings on file");
  });

  it("omits an absent unit without leaving a gap", () => {
    // A marker whose value carries its own text (e.g. "negative") has no unit to announce.
    expect(chartLabel({ name: "ANA", value: "negative", status: "none", date: "2026-02-02" })).toBe(
      "ANA: negative, as of 2026-02-02",
    );
  });

  it("omits the status rather than announcing an empty one", () => {
    const label = chartLabel({ name: "ApoB", value: "90", unit: "mg/dL", status: "none", date: "2026-01-01" });
    expect(label).toBe("ApoB: 90 mg/dL, as of 2026-01-01");
    expect(label).not.toMatch(/,\s*,/);
  });

  it("never trails a separator when the date is missing", () => {
    expect(chartLabel({ name: "ApoB", value: "90", status: "safe" })).toBe("ApoB: 90, in range");
  });
});

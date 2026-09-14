// W76 — the chart's arithmetic, tested away from its SVG.
//
// The defect this guards is a plausible, wrong chart: a value drawn on the safe side of a band it is
// actually outside, an axis quietly showing a different span than its label claims, or a caption
// naming a reading the plot cannot show. None of them throw, none render blank, and a screenshot
// test would pass. `now` is injected so the tick regimes can be asked what they do in any month.

import { describe, it, expect } from "vitest";
import { chartGeometry, type GeometryInput } from "../../src/lib/marker-chart-geometry";
import type { MarkerResult, PersonalizedRange } from "../../src/lib/types";

const PAD = { top: 12, right: 16, bottom: 36, left: 48 };
const PLOT_W = 576;
const PLOT_H = 172;
/** 2026-06-15T12:00:00Z — a fixed "today", so the window boundaries are arithmetic, not the clock. */
const NOW = Date.UTC(2026, 5, 15, 12);

const row = (date: string, value: number, unit = "mg/dL"): MarkerResult =>
  ({ marker: "Ferritin", group: "Iron", source: "lab", date, value, unit }) as MarkerResult;

const range = (over: Partial<PersonalizedRange>): PersonalizedRange =>
  ({ unit: "mg/dL", explanation: "", ...over }) as PersonalizedRange;

function geo(over: Partial<GeometryInput> = {}) {
  return chartGeometry({
    rows: [row("2026-01-10", 40), row("2026-04-10", 60), row("2026-06-01", 50)],
    name: "Ferritin",
    baseUnit: "mg/dL",
    unitSystem: "metric",
    windowYears: 1,
    personal: null,
    pad: PAD,
    plotW: PLOT_W,
    plotH: PLOT_H,
    now: NOW,
    ...over,
  });
}

describe("the plotted window", () => {
  it("drops readings older than the window and keeps the rest in order", () => {
    const g = geo({ rows: [row("2019-01-01", 10), row("2026-01-10", 40), row("2026-06-01", 50)], windowYears: 1 });
    expect(g.points?.map((p) => p.r.value)).toEqual([40, 50]);
  });

  it("spans from the earliest reading when the window is 'all'", () => {
    const g = geo({ rows: [row("2019-01-01", 10), row("2026-06-01", 50)], windowYears: Infinity });
    expect(g.points).toHaveLength(2);
    // The oldest reading anchors the left edge of the plot, exactly.
    expect(g.points![0].cx).toBeCloseTo(PAD.left, 6);
    expect(g.points![1].cx).toBeLessThanOrEqual(PAD.left + PLOT_W);
  });

  it("says so when the newest reading on record is outside the window, rather than plotting nothing quietly", () => {
    const g = geo({ rows: [row("2019-01-01", 10)], windowYears: 1 });
    expect(g.points).toBeNull();
    expect(g.path).toBe("");
    // The caption reads from `latest`, which is the newest ON RECORD — the flag is what stops the
    // card claiming a current value the plot has no point for.
    expect(g.latest?.value).toBe(10);
    expect(g.staleLatest).toBe(true);
  });

  it("is not stale when there is no reading at all", () => {
    const g = geo({ rows: [] });
    expect(g.latest).toBeNull();
    expect(g.staleLatest).toBe(false);
    expect(g.yLabels).toEqual([]);
  });

  it("never draws a point outside the plot area", () => {
    const g = geo({ rows: [row("2025-06-16", 5), row("2026-06-14", 900)], windowYears: 1 });
    for (const p of g.points!) {
      expect(p.cx).toBeGreaterThanOrEqual(PAD.left);
      expect(p.cx).toBeLessThanOrEqual(PAD.left + PLOT_W);
      expect(p.cy).toBeGreaterThanOrEqual(PAD.top);
      expect(p.cy).toBeLessThanOrEqual(PAD.top + PLOT_H);
    }
  });

  it("draws the line through the points it plotted, starting with a move", () => {
    const g = geo();
    expect(g.path.startsWith("M")).toBe(true);
    expect(g.path.split(" ")).toHaveLength(g.points!.length);
    expect(g.path.match(/L/g)).toHaveLength(g.points!.length - 1);
  });
});

describe("the y scale", () => {
  it("puts a higher reading higher on the plot", () => {
    const g = geo({ rows: [row("2026-01-10", 10), row("2026-02-10", 90)] });
    expect(g.points![1].cy).toBeLessThan(g.points![0].cy);
  });

  it("plots a flat series inside the band instead of dividing by a zero range", () => {
    const g = geo({ rows: [row("2026-01-10", 42), row("2026-02-10", 42)] });
    for (const p of g.points!) {
      expect(Number.isFinite(p.cy)).toBe(true);
      expect(p.cy).toBeGreaterThan(PAD.top);
      expect(p.cy).toBeLessThan(PAD.top + PLOT_H);
    }
  });

  it("plots a single zero reading rather than at NaN", () => {
    const g = geo({ rows: [row("2026-01-10", 0)] });
    expect(Number.isFinite(g.points![0].cy)).toBe(true);
  });

  it("switches to the banded scale once a bound exists, and labels the bounds", () => {
    const g = geo({ personal: range({ low: 30, high: 70, generalLow: 20, generalHigh: 90 }) });
    expect(g.zones).not.toBeNull();
    expect(g.yLabels.map((l) => l.label).sort()).toEqual(["20.0", "30.0", "70.0", "90.0"]);
  });

  it("has no bands and no labels for a marker nobody has translated", () => {
    const g = geo({ personal: null });
    expect(g.zones).toBeNull();
    expect(g.yLabels).toEqual([]);
  });

  it("draws a value above the high bound above that bound's own label line", () => {
    const g = geo({ rows: [row("2026-01-10", 50), row("2026-02-10", 200)], personal: range({ low: 30, high: 70 }) });
    const high = g.yLabels.find((l) => l.label === "70.0")!;
    expect(g.points![1].cy).toBeLessThan(high.y);
    expect(g.points![0].cy).toBeGreaterThan(high.y);
  });

  it("brings a bound stated in another unit onto the series' own before plotting it", () => {
    const inMgdl = geo({ rows: [row("2026-01-10", 100)], personal: range({ low: 70, high: 100, unit: "mg/dL" }), name: "Glucose", baseUnit: "mg/dL" });
    const inMmol = geo({ rows: [row("2026-01-10", 100)], personal: range({ low: 3.9, high: 5.6, unit: "mmol/L" }), name: "Glucose", baseUnit: "mg/dL" });
    // Converted, not taken at face value: 3.9 mmol/L IS ~70 mg/dL, so a range stated in either unit
    // must land on the same two lines of the same mg/dL series. Taking the SI numbers at face value
    // is an eighteen-fold error that renders as an ordinary-looking band.
    const a = inMmol.yLabels.map((l) => Number(l.label));
    const b = inMgdl.yLabels.map((l) => Number(l.label));
    expect(a).toHaveLength(2);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 1));
  });
});

describe("the x axis ticks", () => {
  const labels = (windowYears: number) => geo({ windowYears }).ticks.map((t) => t.label);

  it("draws none for an unbounded window, where a year label would imply a precision it lacks", () => {
    expect(labels(Infinity)).toEqual([]);
  });

  it("labels months for a half-year window", () => {
    const l = labels(0.5);
    expect(l.length).toBeGreaterThanOrEqual(4);
    expect(l.every((m) => /^[A-Z][a-z]{2}$/.test(m))).toBe(true);
    expect(new Set(l).size).toBe(l.length);
  });

  it("labels quarters for a one-year window", () => {
    expect(labels(1).every((m) => ["Jan", "Apr", "Jul", "Oct"].includes(m))).toBe(true);
  });

  it("labels every year for a short multi-year window", () => {
    expect(labels(3)).toEqual(["2024", "2025", "2026"]);
  });

  it("thins to every second year past five, and every fifth past ten", () => {
    expect(labels(8)).toEqual(["2020", "2022", "2024", "2026"]);
    expect(labels(20)).toEqual(["2010", "2015", "2020", "2025"]);
  });

  it("keeps every tick inside the plot, in ascending order", () => {
    for (const w of [0.5, 1, 3, 8, 20]) {
      const ticks = geo({ windowYears: w }).ticks;
      const xs = ticks.map((t) => t.x);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
      for (const x of xs) {
        expect(x).toBeGreaterThanOrEqual(PAD.left);
        expect(x).toBeLessThanOrEqual(PAD.left + PLOT_W);
      }
    }
  });

  it("does not label the month a mid-month window starts in, whose tick would sit on the axis origin", () => {
    // NOW is the 15th, so a half-year window opens mid-December.
    expect(labels(0.5)[0]).toBe("Jan");
  });
});

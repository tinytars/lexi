import { describe, it, expect } from "vitest";
import { computeBandedScale, DEFAULT_BAND_FLOORS } from "../../src/lib/chart-scale";
import { computeZones } from "@pablotech/akesi/ranges";

const PLOT_TOP = 8;
const PLOT_H = 74;

// Every band's rendered pixel height, keyed by name, given the plot's fixed geometry.
function heightsOf(scale: ReturnType<typeof computeBandedScale>) {
  const { bands } = scale;
  return {
    dangerLow: bands.dangerLow?.h ?? 0,
    warnLow: bands.warnLow?.h ?? 0,
    safe: bands.safe.h,
    warnHigh: bands.warnHigh?.h ?? 0,
    dangerHigh: bands.dangerHigh?.h ?? 0,
  };
}

describe("computeBandedScale", () => {
  it("the worked example (safe 40-60, general 0-1000) gives the safe zone a legible share, not a sliver", () => {
    const zones = computeZones({ low: 40, high: 60, generalLow: 0, generalHigh: 1000 });
    const scale = computeBandedScale(zones, [40, 50, 60], PLOT_TOP, PLOT_H);
    const h = heightsOf(scale);
    // Old linear scale rendered ~1.1px of 74 (~1.5%); the banded scale must render meaningfully more.
    expect(h.safe).toBeGreaterThan(PLOT_H * 0.2);
    const total = h.dangerLow + h.warnLow + h.safe + h.warnHigh + h.dangerHigh;
    expect(total).toBeCloseTo(PLOT_H, 5);
  });

  it("every existing band meets its configured floor", () => {
    const zones = computeZones({ low: 40, high: 60, generalLow: 0, generalHigh: 1000 });
    const scale = computeBandedScale(zones, [40, 50, 60], PLOT_TOP, PLOT_H);
    const h = heightsOf(scale);
    expect(h.dangerLow).toBeGreaterThanOrEqual(PLOT_H * DEFAULT_BAND_FLOORS.danger - 1e-6);
    expect(h.dangerHigh).toBeGreaterThanOrEqual(PLOT_H * DEFAULT_BAND_FLOORS.danger - 1e-6);
    expect(h.warnLow).toBeGreaterThanOrEqual(PLOT_H * DEFAULT_BAND_FLOORS.warn - 1e-6);
    expect(h.warnHigh).toBeGreaterThanOrEqual(PLOT_H * DEFAULT_BAND_FLOORS.warn - 1e-6);
    expect(h.safe).toBeGreaterThanOrEqual(PLOT_H * DEFAULT_BAND_FLOORS.safe - 1e-6);
  });

  it("only personalized bounds present: safe fills the whole plot, no warn/danger bands", () => {
    const zones = computeZones({ low: 10, high: 20 });
    const scale = computeBandedScale(zones, [10, 15, 20], PLOT_TOP, PLOT_H);
    const h = heightsOf(scale);
    expect(scale.bands.warnLow).toBeNull();
    expect(scale.bands.warnHigh).toBeNull();
    expect(scale.bands.dangerLow).toBeNull();
    expect(scale.bands.dangerHigh).toBeNull();
    expect(h.safe).toBeCloseTo(PLOT_H, 5);
  });

  it("only general bounds present: safe falls back to general, danger starts directly there, no warn", () => {
    const zones = computeZones({ generalLow: 5, generalHigh: 25 });
    const scale = computeBandedScale(zones, [10, 15, 20], PLOT_TOP, PLOT_H);
    expect(scale.bands.warnLow).toBeNull();
    expect(scale.bands.warnHigh).toBeNull();
    expect(scale.bands.dangerLow).not.toBeNull();
    expect(scale.bands.dangerHigh).not.toBeNull();
  });

  it("an outlier beyond the nominal danger span still lands on-chart, never clamped off it", () => {
    const zones = computeZones({ low: 40, high: 60, generalLow: 0, generalHigh: 1000 });
    // 5000 is far beyond generalHigh (1000) and beyond the nominal danger span the scale would
    // otherwise pick (equal to the adjoining warn band's width, 940) — the danger band must grow.
    const scale = computeBandedScale(zones, [40, 50, 60, 5000], PLOT_TOP, PLOT_H);
    const yOutlier = scale.y(5000);
    expect(yOutlier).toBeGreaterThanOrEqual(PLOT_TOP);
    expect(yOutlier).toBeLessThanOrEqual(PLOT_TOP + PLOT_H);
    // It should render essentially at the very top of the chart (the extended band's outer edge).
    expect(yOutlier).toBeCloseTo(PLOT_TOP, 1);

    const yLowOutlier = computeBandedScale(zones, [-500, 40, 50, 60], PLOT_TOP, PLOT_H).y(-500);
    expect(yLowOutlier).toBeGreaterThanOrEqual(PLOT_TOP);
    expect(yLowOutlier).toBeLessThanOrEqual(PLOT_TOP + PLOT_H);
    expect(yLowOutlier).toBeCloseTo(PLOT_TOP + PLOT_H, 1);
  });

  it("a mid-safe-zone value maps inside the safe band's pixel range, not the whole plot", () => {
    const zones = computeZones({ low: 40, high: 60, generalLow: 0, generalHigh: 1000 });
    const scale = computeBandedScale(zones, [40, 50, 60], PLOT_TOP, PLOT_H);
    const ySafeMid = scale.y(50);
    const safe = scale.bands.safe;
    expect(ySafeMid).toBeGreaterThanOrEqual(safe.y - 1e-6);
    expect(ySafeMid).toBeLessThanOrEqual(safe.y + safe.h + 1e-6);
  });

  it("y is monotonically decreasing as value increases across the full domain", () => {
    const zones = computeZones({ low: 40, high: 60, generalLow: 0, generalHigh: 1000 });
    const scale = computeBandedScale(zones, [40, 50, 60], PLOT_TOP, PLOT_H);
    const samples = [-40, -10, 0, 20, 40, 50, 60, 500, 1000, 1940];
    for (let i = 1; i < samples.length; i++) {
      expect(scale.y(samples[i])).toBeLessThanOrEqual(scale.y(samples[i - 1]) + 1e-9);
    }
  });
});

// Where a marker's reading lands on the plot, as arithmetic rather than as markup.
//
// W76 — this was 130 lines inside MarkerChart.svelte's `$derived.by`, in a 610-line component with
// no coverage and the densest branch pocket outside App.svelte. Every branch here decides something
// a patient reads as fact: which side of a reference band their value sits on, how many years of
// history the axis is actually showing, and whether the number in the caption is even from the
// window the plot draws. A wrong scale produces a plausible, wrong chart and nothing errors — there
// is no exception to catch and no blank to notice.
//
// Pure by construction: `now` is a parameter, not Date.now(), so the tick derivation can be asked
// what it does in December without waiting for December. The SVG stays in the component.

import type { MarkerResult, PersonalizedRange } from "./types";
import { computeZones } from "@pablotech/akesi/ranges";
import { computeBandedScale } from "./chart-scale";
import { displayScaleFor, fmtNum, type UnitSystem } from "./units";
import { toCanonical, canonicalUnit } from "@pablotech/akesi/unit-systems";

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface GeometryInput {
  /** Unit-reconciled readings, oldest first — normalizeSeries' output, not the raw rows. */
  rows: MarkerResult[];
  name: string;
  /** The unit the series was folded to; every bound is brought onto it before it is plotted. */
  baseUnit: string;
  unitSystem: UnitSystem;
  /** The x-axis span in years. `Infinity` means "all of it", which draws no ticks. */
  windowYears: number;
  personal: PersonalizedRange | null;
  pad: Padding;
  plotW: number;
  plotH: number;
  now: number;
}

export interface AxisTick {
  x: number;
  label: string;
}
export interface PlotPoint {
  cx: number;
  cy: number;
  r: MarkerResult;
}
export interface YLabel {
  y: number;
  label: string;
}

export interface ChartGeometry {
  ticks: AxisTick[];
  points: PlotPoint[] | null;
  path: string;
  zones: ReturnType<typeof computeBandedScale>["bands"] | null;
  /** The newest reading ON RECORD, which is not necessarily inside the window. */
  latest: MarkerResult | null;
  /** True when `latest` is outside the drawn window — the caption is about to name a point the plot cannot show. */
  staleLatest: boolean;
  yLabels: YLabel[];
  displayScale: number;
  displayUnit: string;
}

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The x-axis ticks for a window.
 *
 * Three regimes, because a label every month across ten years is unreadable and a label every year
 * across six months is empty: months up to half a year, quarters up to a year, then years on a
 * stride that widens as the window does. "All" draws none — the span is arbitrary, so a year label
 * would imply a precision the axis does not have.
 */
function axisTicks(windowYears: number, tMin: number, tMax: number, x: (t: number) => number): AxisTick[] {
  const ticks: AxisTick[] = [];
  if (!isFinite(windowYears)) return ticks;

  if (windowYears <= 0.5) {
    const start = new Date(tMin);
    let year = start.getFullYear();
    let month = start.getMonth();
    // A window starting mid-month has no tick for that month — its label would sit at the axis
    // origin and read as if the month began there.
    if (start.getDate() !== 1) month++;
    // Normalise the rollover HERE as well as in the loop. Without it a window opening in December
    // enters the loop at month 12, which is January of the next year — and the loop's own rollover
    // then produces January a second time, drawing the label twice on the same pixel (W76).
    if (month >= 12) {
      month = 0;
      year++;
    }
    for (let i = 0; i < 12; i++) {
      const t = new Date(year, month, 1).getTime();
      if (t > tMax) break;
      if (t >= tMin) ticks.push({ x: x(t), label: MONTHS[month % 12] });
      month++;
      if (month >= 12) {
        month = 0;
        year++;
      }
    }
    return ticks;
  }

  if (windowYears <= 1) {
    const labels = ["Jan", "Apr", "Jul", "Oct"];
    const start = new Date(tMin);
    const startYear = start.getFullYear();
    const startQ = Math.floor(start.getMonth() / 3);
    for (let i = 0; i < 8; i++) {
      const year = startYear + Math.floor((startQ + i) / 4);
      const month = ((startQ + i) % 4) * 3;
      const t = new Date(year, month, 1).getTime();
      if (t < tMin) continue;
      if (t > tMax) break;
      ticks.push({ x: x(t), label: labels[month / 3] });
    }
    return ticks;
  }

  const stride = windowYears > 10 ? 5 : windowYears > 5 ? 2 : 1;
  const startYear = new Date(tMin).getFullYear();
  const endYear = new Date(tMax).getFullYear();
  const first = Math.ceil(startYear / stride) * stride;
  for (let y = first; y <= endYear + 1; y += stride) {
    const t = new Date(y, 0, 1).getTime();
    if (t < tMin || t > tMax) continue;
    ticks.push({ x: x(t), label: String(y) });
  }
  return ticks;
}

export function chartGeometry(input: GeometryInput): ChartGeometry {
  const { rows, name, baseUnit, unitSystem, windowYears, personal, pad, plotW, plotH, now } = input;

  /**
   * A bound onto the series' OWN unit — which is not always the canonical one.
   *
   * W76 — this used to be `toCanonical(...).value` and stop there. That is right for a mixed-unit
   * series, which normalizeSeries has already folded to SI, and wrong for a single-unit series
   * stored in the analyte's US unit: a range stated in mmol/L against a mg/dL series came back in
   * mmol/L and was then plotted, and label-scaled, as though it were mg/dL — an eighteen-fold error
   * drawn as a perfectly ordinary reference band. Convert the bound up to canonical, then back down
   * by whatever the base unit's own factor is.
   */
  const toBase = (v: number | null | undefined, fromUnit: string): number | null | undefined => {
    if (v == null || fromUnit === baseUnit) return v;
    const canonical = toCanonical(name, fromUnit, v).value;
    const perBaseUnit = toCanonical(name, baseUnit, 1);
    return perBaseUnit.unit === canonicalUnit(baseUnit) ? canonical : canonical / perBaseUnit.value;
  };

  const tMax = now;
  const showAll = !isFinite(windowYears);
  const earliest = rows.length > 0 ? Math.min(...rows.map((r) => new Date(r.date).getTime())) : now;
  const tMin = showAll ? earliest : now - windowYears * YEAR_MS;

  const inWindow = rows.filter((r) => {
    const t = new Date(r.date).getTime();
    return t >= tMin && t <= tMax;
  });
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;

  const x = (t: number): number => pad.left + ((t - tMin) / (tMax - tMin)) * plotW;
  const ticks = axisTicks(windowYears, tMin, tMax, x);

  if (inWindow.length === 0) {
    const { scale, unit } = displayScaleFor(name, baseUnit, 0, unitSystem);
    return { ticks, latest, staleLatest: latest !== null, points: null, path: "", zones: null, yLabels: [], displayScale: scale, displayUnit: unit };
  }

  const values = inWindow.map((r) => r.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);

  const ref = personal && (personal.low != null || personal.high != null) ? { low: toBase(personal.low, personal.unit), high: toBase(personal.high, personal.unit) } : undefined;
  const generalRef =
    personal && (personal.generalLow != null || personal.generalHigh != null)
      ? { low: toBase(personal.generalLow, personal.unit), high: toBase(personal.generalHigh, personal.unit) }
      : undefined;

  const zoneBounds = computeZones(
    personal
      ? {
          low: toBase(personal.low, personal.unit) ?? undefined,
          high: toBase(personal.high, personal.unit) ?? undefined,
          generalLow: toBase(personal.generalLow, personal.unit) ?? undefined,
          generalHigh: toBase(personal.generalHigh, personal.unit) ?? undefined,
        }
      : null,
  );

  // Banded piecewise scale when at least one zone bound exists — each zone gets a guaranteed minimum
  // pixel share of plotH, rather than a flat linear map that squeezes a narrow personalized range
  // against a wide general one down to a sliver. With no bound at all (a never-translated marker),
  // a plain linear scale over the data alone.
  let y: (v: number) => number;
  let zones: ReturnType<typeof computeBandedScale>["bands"] | null;
  if (isFinite(zoneBounds.safeLow) || isFinite(zoneBounds.safeHigh)) {
    const scale = computeBandedScale(zoneBounds, values, pad.top, plotH);
    y = scale.y;
    zones = scale.bands;
  } else {
    // A flat series has no range to pad; fall back to the magnitude, then to 1, so the divisor is
    // never zero and a single reading plots at the middle of the band instead of at NaN.
    const range = maxV - minV || Math.abs(maxV) || 1;
    const p = range * 0.15;
    const yLo = minV - p;
    const yHi = maxV + p;
    y = (v: number) => pad.top + (1 - (v - yLo) / (yHi - yLo)) * plotH;
    zones = null;
  }

  const points = inWindow.map((r) => ({ cx: x(new Date(r.date).getTime()), cy: y(r.value), r }));
  const path = points.map((p, i) => `${i ? "L" : "M"}${p.cx.toFixed(2)},${p.cy.toFixed(2)}`).join(" ");

  const dataMaxAbs = Math.max(Math.abs(maxV), Math.abs(minV));
  const { scale: displayScale, unit: displayUnit } = displayScaleFor(name, baseUnit, dataMaxAbs, unitSystem);

  const labelValues = new Set<number>();
  if (ref?.low != null) labelValues.add(ref.low);
  if (ref?.high != null) labelValues.add(ref.high);
  if (generalRef?.low != null) labelValues.add(generalRef.low);
  if (generalRef?.high != null) labelValues.add(generalRef.high);
  const yLabels: YLabel[] = [...labelValues].map((v) => ({ y: y(v), label: fmtNum(v * displayScale) }));

  return { ticks, points, path, zones, latest, staleLatest: false, yLabels, displayScale, displayUnit };
}

import type { Zones } from "@pablotech/akesi/ranges";

export interface BandFloors {
  danger: number;
  warn: number;
  safe: number;
}

export const DEFAULT_BAND_FLOORS: BandFloors = { danger: 0.1, warn: 0.15, safe: 0.25 };

export interface BandRect {
  y: number;
  h: number;
}

export interface BandedScale {
  y: (v: number) => number;
  bands: {
    dangerLow: BandRect | null;
    warnLow: BandRect | null;
    safe: BandRect;
    warnHigh: BandRect | null;
    dangerHigh: BandRect | null;
  };
}

interface Band {
  lo: number;
  hi: number;
  pxTop: number;
  pxBottom: number;
}

// Builds a piecewise y-scale that gives every zone that actually exists (danger/warn/safe, per
// `zones` from computeZones) a guaranteed minimum pixel share of plotH, then fills remaining
// space proportional to each zone's real value-width — so a personalized range much narrower
// than the general (lab/guideline) range still renders as a legible band instead of being
// squeezed to a sub-pixel sliver (M60 Part C). Only call this when at least one of
// `zones.safeLow`/`safeHigh` is finite; an entirely open-ended marker (no personal or general
// bound at all) has no zone to bound a piecewise scale with and should use a plain linear scale
// over `values` instead.
export function computeBandedScale(
  zones: Zones,
  values: number[],
  plotTop: number,
  plotH: number,
  floors: BandFloors = DEFAULT_BAND_FLOORS,
): BandedScale {
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  const hasWarnHigh = zones.warnHighBound != null;
  const hasWarnLow = zones.warnLowBound != null;
  const hasDangerHigh = zones.dangerHighBound != null;
  const hasDangerLow = zones.dangerLowBound != null;

  const rawSafeLo = zones.safeLow;
  const rawSafeHi = zones.safeHigh;
  const finiteSafeSpan = isFinite(rawSafeLo) && isFinite(rawSafeHi) ? rawSafeHi - rawSafeLo : null;

  // Danger zones are conceptually unbounded, so give each a nominal value-span to interpolate
  // within — mirroring the adjoining warn band's width when one exists, else half the safe
  // span (or a fixed fallback) — then grow it further if a historical outlier sits beyond that
  // nominal span, so the outlier is never clamped off the chart.
  let dangerLoInner: number | null = null;
  let dangerLoOuter: number | null = null;
  if (hasDangerLow) {
    dangerLoInner = hasWarnLow ? zones.warnLowBound! : rawSafeLo;
    const adjoiningWidth = hasWarnLow
      ? rawSafeLo - zones.warnLowBound!
      : (finiteSafeSpan ?? (Math.abs(dangerLoInner) || 1)) * 0.5;
    const nominalSpan = adjoiningWidth > 0 ? adjoiningWidth : Math.max(Math.abs(dangerLoInner) || 1, 1);
    dangerLoOuter = dangerLoInner - nominalSpan;
  }
  let outermostLo = hasDangerLow
    ? dangerLoOuter!
    : hasWarnLow
      ? zones.warnLowBound!
      : isFinite(rawSafeLo)
        ? rawSafeLo
        : dataMin;
  outermostLo = Math.min(outermostLo, dataMin);

  let dangerHiInner: number | null = null;
  let dangerHiOuter: number | null = null;
  if (hasDangerHigh) {
    dangerHiInner = hasWarnHigh ? zones.warnHighBound! : rawSafeHi;
    const adjoiningWidth = hasWarnHigh
      ? zones.warnHighBound! - rawSafeHi
      : (finiteSafeSpan ?? (Math.abs(dangerHiInner) || 1)) * 0.5;
    const nominalSpan = adjoiningWidth > 0 ? adjoiningWidth : Math.max(Math.abs(dangerHiInner) || 1, 1);
    dangerHiOuter = dangerHiInner + nominalSpan;
  }
  let outermostHi = hasDangerHigh
    ? dangerHiOuter!
    : hasWarnHigh
      ? zones.warnHighBound!
      : isFinite(rawSafeHi)
        ? rawSafeHi
        : dataMax;
  outermostHi = Math.max(outermostHi, dataMax);

  const safeLo = hasWarnLow || hasDangerLow ? rawSafeLo : outermostLo;
  const safeHi = hasWarnHigh || hasDangerHigh ? rawSafeHi : outermostHi;
  const warnLowRange: [number, number] | null = hasWarnLow
    ? [hasDangerLow ? zones.warnLowBound! : outermostLo, safeLo]
    : null;
  const warnHighRange: [number, number] | null = hasWarnHigh
    ? [safeHi, hasDangerHigh ? zones.warnHighBound! : outermostHi]
    : null;
  const dangerLowRange: [number, number] | null = hasDangerLow ? [outermostLo, dangerLoInner!] : null;
  const dangerHighRange: [number, number] | null = hasDangerHigh ? [dangerHiInner!, outermostHi] : null;

  const widthOf = (r: [number, number] | null) => (r ? r[1] - r[0] : 0);
  const wSafe = Math.max(safeHi - safeLo, 0);
  const wWarnLow = widthOf(warnLowRange);
  const wWarnHigh = widthOf(warnHighRange);
  const wDangerLow = widthOf(dangerLowRange);
  const wDangerHigh = widthOf(dangerHighRange);
  const totalWidth = wSafe + wWarnLow + wWarnHigh + wDangerLow + wDangerHigh;

  const onlyZoneIsSafe = !hasWarnLow && !hasWarnHigh && !hasDangerLow && !hasDangerHigh;
  let fDangerHigh = hasDangerHigh ? floors.danger * plotH : 0;
  let fDangerLow = hasDangerLow ? floors.danger * plotH : 0;
  let fWarnHigh = hasWarnHigh ? floors.warn * plotH : 0;
  let fWarnLow = hasWarnLow ? floors.warn * plotH : 0;
  let fSafe = onlyZoneIsSafe ? plotH : floors.safe * plotH;

  let floorSum = fDangerHigh + fDangerLow + fWarnHigh + fWarnLow + fSafe;
  if (floorSum > plotH) {
    const scale = plotH / floorSum;
    fDangerHigh *= scale;
    fDangerLow *= scale;
    fWarnHigh *= scale;
    fWarnLow *= scale;
    fSafe *= scale;
    floorSum = plotH;
  }
  const remaining = plotH - floorSum;
  const bonus = (w: number) => (totalWidth > 0 ? remaining * (w / totalWidth) : 0);

  const hDangerHigh = fDangerHigh + (hasDangerHigh ? bonus(wDangerHigh) : 0);
  const hWarnHigh = fWarnHigh + (hasWarnHigh ? bonus(wWarnHigh) : 0);
  const hSafe = fSafe + (totalWidth > 0 ? bonus(wSafe) : remaining);
  const hWarnLow = fWarnLow + (hasWarnLow ? bonus(wWarnLow) : 0);
  const hDangerLow = fDangerLow + (hasDangerLow ? bonus(wDangerLow) : 0);

  let cursor = plotTop;
  const dangerHighRect = hasDangerHigh ? { y: cursor, h: hDangerHigh } : null;
  if (hasDangerHigh) cursor += hDangerHigh;
  const warnHighRect = hasWarnHigh ? { y: cursor, h: hWarnHigh } : null;
  if (hasWarnHigh) cursor += hWarnHigh;
  const safeRect: BandRect = { y: cursor, h: hSafe };
  cursor += hSafe;
  const warnLowRect = hasWarnLow ? { y: cursor, h: hWarnLow } : null;
  if (hasWarnLow) cursor += hWarnLow;
  const dangerLowRect = hasDangerLow ? { y: cursor, h: hDangerLow } : null;

  const bandsHighToLow: Band[] = [];
  if (dangerHighRect && dangerHighRange) {
    bandsHighToLow.push({ lo: dangerHighRange[0], hi: dangerHighRange[1], pxTop: dangerHighRect.y, pxBottom: dangerHighRect.y + dangerHighRect.h });
  }
  if (warnHighRect && warnHighRange) {
    bandsHighToLow.push({ lo: warnHighRange[0], hi: warnHighRange[1], pxTop: warnHighRect.y, pxBottom: warnHighRect.y + warnHighRect.h });
  }
  bandsHighToLow.push({ lo: safeLo, hi: safeHi, pxTop: safeRect.y, pxBottom: safeRect.y + safeRect.h });
  if (warnLowRect && warnLowRange) {
    bandsHighToLow.push({ lo: warnLowRange[0], hi: warnLowRange[1], pxTop: warnLowRect.y, pxBottom: warnLowRect.y + warnLowRect.h });
  }
  if (dangerLowRect && dangerLowRange) {
    bandsHighToLow.push({ lo: dangerLowRange[0], hi: dangerLowRange[1], pxTop: dangerLowRect.y, pxBottom: dangerLowRect.y + dangerLowRect.h });
  }

  function y(v: number): number {
    for (const b of bandsHighToLow) {
      if (v <= b.hi && v >= b.lo) {
        const frac = b.hi === b.lo ? 0 : (v - b.lo) / (b.hi - b.lo);
        return b.pxBottom - frac * (b.pxBottom - b.pxTop);
      }
    }
    return v > bandsHighToLow[0].hi ? bandsHighToLow[0].pxTop : bandsHighToLow[bandsHighToLow.length - 1].pxBottom;
  }

  return {
    y,
    bands: {
      dangerLow: dangerLowRect,
      warnLow: warnLowRect,
      safe: safeRect,
      warnHigh: warnHighRect,
      dangerHigh: dangerHighRect,
    },
  };
}

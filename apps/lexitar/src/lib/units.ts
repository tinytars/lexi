// Display-layer unit formatting + conversion. The conversion registry (US/SI per-analyte
// + physical) lives in ./unit-systems; this module is the display surface over it.
import { ANALYTE, PHYSICAL_TO_IMPERIAL, PHYSICAL_NO_CONVERT, canonicalUnit, type UnitSystem } from "@pablotech/akesi-pil/unit-systems";

export type { UnitSystem };

export function fmtNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// Render a personalized-range's bounds verbatim (no fmtNum rounding — the table
// shows the stored target as-is). Titers read as "1:80", not "80 titer".
export function fmtRangeStr(
  low: number | null | undefined,
  high: number | null | undefined,
  unit: string,
): string | null {
  const b = (n: number) => (unit === "titer" ? `1:${n}` : `${n}`);
  const suffix = unit && unit !== "titer" ? ` ${unit}` : "";
  if (low != null && high != null) return `${b(low)}–${b(high)}${suffix}`;
  if (high != null) return `< ${b(high)}${suffix}`;
  if (low != null) return `> ${b(low)}${suffix}`;
  return null;
}

// Render a personalized-range's bounds with fmtNum rounding for the AI-discussion panel;
// low===0 collapses to "< high" (the API stores 0 as "no floor", not a real lower bound).
export function fmtRange(
  low: number | undefined | null,
  high: number | undefined | null,
  unit: string,
): string | null {
  if (low == null && high == null) return null;
  const b = (n: number) => (unit === "titer" ? `1:${fmtNum(n)}` : fmtNum(n));
  const suffix = unit && unit !== "titer" ? ` ${unit}` : "";
  if (low === 0 && high != null) return `< ${b(high)}${suffix}`;
  if (low != null && high != null) return `${b(low)}–${b(high)}${suffix}`;
  if (high != null) return `< ${b(high)}${suffix}`;
  return `> ${b(low!)}${suffix}`;
}

// Scale + display unit for a marker series whose readings are in `baseUnit` (single unit —
// the caller reconciles mixed series via normalizeSeries first). Handles BOTH directions of
// an analyte rule (data may be stored in either the US or SI unit) and physical conversions.
// Returns a scalar `scale` so every reading in the series can be multiplied uniformly.
export function displayScaleFor(
  marker: string,
  baseUnit: string,
  dataMaxAbs: number,
  system: UnitSystem,
): { scale: number; unit: string } {
  const baseUnitCanonical = canonicalUnit(baseUnit); // M93 — collapses cosmetic same-unit string variants (e.g. eGFR)
  const a = ANALYTE[marker];
  if (a && (baseUnitCanonical === a.us || baseUnitCanonical === a.si)) {
    const target = system === "imperial" ? a.us : a.si;
    if (baseUnitCanonical === target) return { scale: 1, unit: target };
    // us → si multiplies by k; si → us divides by k.
    return baseUnitCanonical === a.us ? { scale: a.k, unit: a.si } : { scale: 1 / a.k, unit: a.us };
  }
  // Physical: g→kg auto-scale for large masses, then imperial conversion if requested — unless
  // this marker's metric unit is the US-prevailing convention too (M93 PHYSICAL_NO_CONVERT).
  const useKg = baseUnitCanonical === "g" && dataMaxAbs > 1000;
  let scale = useKg ? 0.001 : 1;
  let unit = useKg ? "kg" : baseUnitCanonical;
  if (system === "imperial" && !PHYSICAL_NO_CONVERT.has(marker)) {
    const conv = PHYSICAL_TO_IMPERIAL[unit];
    if (conv) { scale *= conv.factor; unit = conv.unit; }
  }
  return { scale, unit };
}

// Convert one reading's value+unit to the chosen system (per-reading; used by export + chat).
export function convertForDisplay(
  marker: string,
  unit: string,
  value: number,
  system: UnitSystem,
): { value: number; unit: string } {
  const { scale, unit: u } = displayScaleFor(marker, unit, Math.abs(value), system);
  return { value: value * scale, unit: u };
}

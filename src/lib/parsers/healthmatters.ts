import { readSheetRows } from "./xlsx-safe";
import type { MarkerResult } from "../types";

function parseRefRange(raw: unknown): MarkerResult["ref"] {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(-?\d+(?:\.\d+)?)/i);
  if (m) return { low: parseFloat(m[1]), high: parseFloat(m[2]) };
  const lt = s.match(/^[<≤]\s*(-?\d+(?:\.\d+)?)/);
  if (lt) return { high: parseFloat(lt[1]) };
  const gt = s.match(/^[>≥]\s*(-?\d+(?:\.\d+)?)/);
  if (gt) return { low: parseFloat(gt[1]) };
  return undefined;
}

function parseDate(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const s = String(raw).trim();
  if (!s) return undefined;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return undefined;
}

// Parse a result cell into a numeric value plus, for semi-quantitative results,
// a display string. Antibody titers ("1:80", "<1:20", "1:40 to 1:80 -- ...")
// are reported as a reciprocal dilution; store that dilution as the numeric
// value (higher = more antibody, so it sorts/charts correctly) and keep the
// titer text for display. Without this, parseFloat("1:40 to 1:80") silently
// returns 1 and "<1:20" returns NaN (dropping the reading entirely).
export function parseReadingValue(raw: unknown): { value: number; valueText?: string } | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "number") return isFinite(raw) ? { value: raw } : undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const range = s.match(/1\s*:\s*(\d+)\s*(?:-|to|–|—)\s*1\s*:\s*(\d+)/i);
  if (range) {
    const a = parseInt(range[1], 10), b = parseInt(range[2], 10);
    return { value: Math.max(a, b), valueText: `1:${a} to 1:${b}` };
  }
  const single = s.match(/^([<≤>≥]?)\s*1\s*:\s*(\d+)\b/);
  if (single) {
    const n = parseInt(single[2], 10);
    return { value: n, valueText: `${single[1] ?? ""}1:${n}` };
  }
  const n = parseFloat(s);
  return isFinite(n) ? { value: n } : undefined;
}

function isBlankRow(row: unknown[]): boolean {
  return row.every((c) => c == null || (typeof c === "string" && c.trim() === ""));
}

function isSectionHeader(row: unknown[]): boolean {
  return typeof row[1] === "string" && row[1].trim().toLowerCase() === "unit";
}

const NORMALIZE: Record<string, { from: string; to: string; factor: number }> = {
  "Triglycerides": { from: "mmol/L", to: "mg/dL", factor: 88.57 },
  "HDL-C": { from: "mmol/L", to: "mg/dL", factor: 38.67 },
  "LDL-C": { from: "mmol/L", to: "mg/dL", factor: 38.67 },
  "Non-HDL Cholesterol": { from: "mmol/L", to: "mg/dL", factor: 38.67 },
  "Total Cholesterol": { from: "mmol/L", to: "mg/dL", factor: 38.67 },
  "VLDL Cholesterol Cal": { from: "mmol/L", to: "mg/dL", factor: 38.67 },
  "Glucose": { from: "mmol/L", to: "mg/dL", factor: 18.02 },
  "Estimated Average Glucose (eAG)": { from: "mmol/L", to: "mg/dL", factor: 18.02 },
  "Apolipoprotein B": { from: "g/L", to: "mg/dL", factor: 100 },
  "Apolipoprotein A-1": { from: "g/L", to: "mg/dL", factor: 100 },
};

function normalize(marker: string, unit: string, value: number, ref: MarkerResult["ref"]): { unit: string; value: number; ref: MarkerResult["ref"] } {
  const rule = NORMALIZE[marker];
  if (!rule || unit !== rule.from) return { unit, value, ref };
  const k = rule.factor;
  return {
    unit: rule.to,
    value: value * k,
    ref: ref ? { low: ref.low != null ? ref.low * k : undefined, high: ref.high != null ? ref.high * k : undefined } : undefined,
  };
}

// Content sniffer: a HealthMatters export is identified by its section-header rows
// (row[1] === "unit"), the same signal parseHealthmatters trusts to open a section.
// Lets the dispatcher route by content, not extension, and reject foreign spreadsheets.
export function isHealthmatters(bytes: Uint8Array): boolean {
  return readSheetRows(bytes).some(isSectionHeader);
}

export async function parseHealthmatters(bytes: Uint8Array): Promise<MarkerResult[]> {
  const rows = readSheetRows(bytes);

  const out: MarkerResult[] = [];
  let dateCols: { idx: number; date: string }[] = [];
  let group = "";

  for (const row of rows) {
    if (isBlankRow(row)) {
      dateCols = [];
      continue;
    }
    if (isSectionHeader(row)) {
      group = typeof row[0] === "string" ? row[0].trim() : "";
      dateCols = [];
      for (let i = 3; i < row.length; i++) {
        const d = parseDate(row[i]);
        if (d) dateCols.push({ idx: i, date: d });
      }
      continue;
    }
    if (dateCols.length === 0) continue;
    const marker = typeof row[0] === "string" ? row[0].trim() : "";
    if (!marker) continue;
    const unit = typeof row[1] === "string" ? row[1].trim() : "";
    const ref = parseRefRange(row[2]);
    for (const { idx, date } of dateCols) {
      const parsed = parseReadingValue(row[idx]);
      if (parsed === undefined) continue;
      const cellUnit = parsed.valueText && !unit ? "titer" : unit;
      const norm = normalize(marker, cellUnit, parsed.value, ref);
      out.push({
        marker, group, source: "Blood", date,
        value: norm.value, unit: norm.unit, ref: norm.ref,
        ...(parsed.valueText ? { valueText: parsed.valueText } : {}),
      });
    }
  }
  return out;
}

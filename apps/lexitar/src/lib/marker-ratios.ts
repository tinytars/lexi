// Marker Ratios — compute a CriticalRatio's value series and ranges so the dashboard
// can render it "just like any other marker" (a MarkerChart with a personalized band)
// and the print "Critical Ratios" section can show its current value.
//
// Components are not always drawn on the same day (a lipid panel and a hormone panel
// land weeks apart), so readings are paired by QUARTER: within each quarter take the
// latest reading of each component, and where both exist, the ratio = numerator /
// denominator, dated at the later of the two component readings.

import type { Client, CriticalRatio, MarkerResult, PersonalizedRange } from "./types";
import { resolveRange } from "@pablotech/akesi-pil/ranges";

export function quarterKey(date: string): string {
  const [y, m] = date.split("-");
  const q = Math.floor((parseInt(m, 10) - 1) / 3) + 1;
  return `${y}-Q${q}`;
}

function latestPerQuarter(client: Client, marker: string): Map<string, MarkerResult> {
  const map = new Map<string, MarkerResult>();
  for (const r of client.results) {
    if (r.marker !== marker) continue;
    const q = quarterKey(r.date);
    const prev = map.get(q);
    if (!prev || r.date.localeCompare(prev.date) > 0) map.set(q, r);
  }
  return map;
}

// The ratio's value series — one point per quarter where BOTH components have a
// reading. Sorted ascending by date. Empty when the components never share a quarter.
export function ratioSeries(client: Client, ratio: CriticalRatio): MarkerResult[] {
  const num = latestPerQuarter(client, ratio.numerator);
  const den = latestPerQuarter(client, ratio.denominator);
  const out: MarkerResult[] = [];
  for (const [q, nr] of num) {
    const dr = den.get(q);
    if (!dr || dr.value === 0) continue;
    const date = nr.date.localeCompare(dr.date) >= 0 ? nr.date : dr.date;
    out.push({ marker: ratio.name, group: "Marker Ratios", source: "Ratio", date, value: nr.value / dr.value, unit: ratio.unit });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// A PersonalizedRange built from the ratio's Finding-supplied bounds, so MarkerChart
// renders the General + Personalized bands unchanged. factorsHash is matched to the
// client's so the range is never flagged "stale". The ratio's meaning maps to the
// range's `meaning` so it renders as the chart's "What this is:" line, exactly like a
// regular marker; the explanation carries only the personalized rationale.
export function ratioRange(ratio: CriticalRatio, client: Client): PersonalizedRange {
  return {
    low: ratio.personalizedLow,
    high: ratio.personalizedHigh,
    unit: ratio.unit,
    meaning: ratio.meaning,
    explanation: ratio.explanation || ratio.meaning,
    generalLow: ratio.generalLow,
    generalHigh: ratio.generalHigh,
    generalExplanation: ratio.generalExplanation,
    generatedAt: client.finding?.generatedAt ?? "",
    factorsHash: client.factorsHash ?? "",
    generatedBy: client.finding?.generatedBy,
  };
}

// Critical ratios are ADDITIVE across Finding regenerations: a re-run may surface
// new ratios but must never silently drop ones already locked in — removal is
// explicit (the ingest `--remove-ratio` flag). Prior entries are preserved
// verbatim; only genuinely new ones from `next` are appended.
//
// Dedup is by the COMPONENT PAIR (numerator|denominator), not the display name —
// a regeneration routinely renames the same ratio ("ApoB : ApoA-1" vs
// "Apolipoprotein B : Apolipoprotein A-1"; "Triglycerides : HDL" vs ": HDL-C"),
// and those are the same metric, not a new one. Keying on the underlying markers
// collapses the rename while still admitting a ratio over a genuinely different
// pair. First occurrence wins, so a locked entry beats a later rename of it.
export function mergeCriticalRatios(prior: CriticalRatio[], next: CriticalRatio[]): CriticalRatio[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const key = (r: CriticalRatio) => `${norm(r.numerator)}|${norm(r.denominator)}`;
  const out = new Map<string, CriticalRatio>();
  for (const r of [...prior, ...next]) {
    const k = key(r);
    if (!out.has(k)) out.set(k, r);
  }
  return [...out.values()];
}

export interface RatioView {
  ratio: { name: string };
  rows: MarkerResult[];
  range: PersonalizedRange | null;
}

// M61 Part B — detects a raw lab-reported marker that is itself a ratio (e.g. "BUN/Creatinine
// Ratio"), so buildMarkerRatios can surface it in the Marker Ratios block alongside the
// Finding-generated ones, without requiring an isRatio flag on MarkerResult.
export function isRatioMarkerName(name: string): boolean {
  return /\bratio\b/i.test(name);
}

// Best-effort "X/Y Ratio" -> component pair, for dedup against a generated CriticalRatio's
// numerator/denominator. Returns null when the name doesn't parse (still eligible for
// inclusion, just without a component-pair dedup key — falls back to exact-name dedup only).
function parseRatioComponents(name: string): { num: string; den: string } | null {
  const m = name.match(/^(.+?)\s*\/\s*(.+?)\s+ratio$/i);
  return m ? { num: m[1].trim(), den: m[2].trim() } : null;
}

const norm = (s: string) => s.trim().toLowerCase();

// Raw ratio markers already present in client.results, excluding anything already covered by
// a generated CriticalRatio (by name or component pair, per excludeKeys — built by the caller).
export function buildRawRatioViews(client: Client, excludeKeys: Set<string>): RatioView[] {
  const names = new Set<string>();
  for (const r of client.results) {
    if (isRatioMarkerName(r.marker)) names.add(r.marker);
  }
  const out: RatioView[] = [];
  for (const name of names) {
    const pair = parseRatioComponents(name);
    const pairKey = pair ? `${norm(pair.num)}|${norm(pair.den)}` : null;
    if (excludeKeys.has(norm(name)) || (pairKey && excludeKeys.has(pairKey))) continue;
    const rows = client.results
      .filter((r) => r.marker === name)
      .sort((a, b) => a.date.localeCompare(b.date));
    out.push({ ratio: { name }, rows, range: resolveRange(name, client) });
  }
  return out;
}

// Dashboard ratios: generated (Finding criticalRatios, ≥1 shared-quarter point) union raw
// ratio-named markers from client.results not already covered by a generated ratio.
export function buildMarkerRatios(client: Client): RatioView[] {
  const ratios = client.finding?.criticalRatios ?? [];
  const generated = ratios
    .map((ratio) => ({ ratio, rows: ratioSeries(client, ratio), range: ratioRange(ratio, client) }))
    .filter((rv) => rv.rows.length > 0);

  const excludeKeys = new Set<string>();
  for (const rv of generated) {
    excludeKeys.add(norm(rv.ratio.name));
    excludeKeys.add(`${norm(rv.ratio.numerator)}|${norm(rv.ratio.denominator)}`);
  }
  return [...generated, ...buildRawRatioViews(client, excludeKeys)];
}

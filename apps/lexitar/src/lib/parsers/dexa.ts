import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { MarkerResult } from "../types";

// W72 — exported so the geometry can be tested without a PDF.
//
// Everything below the pdfjs call is coordinate arithmetic over a bag of positioned strings, and that
// is where a DEXA import actually goes wrong: a column x-offset that no longer matches the report
// layout produces a marker list that is WRONG rather than empty, silently, on clinical data. Wrapping
// it in a pdfjs call meant it had no test coverage at all — the parser could only be exercised by
// feeding it a real scan, which is PHI and cannot be a fixture.
export type DexaItem = { str: string; x: number; y: number };
export type DexaPage = DexaItem[];
type Page = DexaPage;

const GROUP_BC_TOTAL = "Body Composition – Total";
const GROUP_BC_REGION = "Body Composition – Regional";
const GROUP_BMD = "Bone Density";
const GROUP_BMD_REGION = "Bone Density – Regional";

const COMPOSITION_INDICES: { label: string; marker: string; unit: string }[] = [
  { label: "Total body weight (kg)", marker: "Total body weight", unit: "kg" },
  { label: "Body mass index (kg/m²) (BMI)", marker: "BMI", unit: "kg/m²" },
  { label: "Basal metabolic rate (kcal/Day)", marker: "Basal metabolic rate", unit: "kcal/day" },
  { label: "Total body % Fat", marker: "Total body % Fat", unit: "%" },
  { label: "Fat mass/height² (kg/m²) (FMI)", marker: "Fat mass index (FMI)", unit: "kg/m²" },
  { label: "Android/Gynoid % fat ratio", marker: "Android/Gynoid % fat ratio", unit: "" },
  { label: "Trunk/legs % fat ratio", marker: "Trunk/legs % fat ratio", unit: "" },
  { label: "Trunk/limb fat mass ratio", marker: "Trunk/limb fat mass ratio", unit: "" },
  { label: "Visceral Adipose Tissue Area (cm²)", marker: "Visceral adipose tissue area", unit: "cm²" },
  { label: "Visceral Adipose Tissue Mass (g)", marker: "Visceral adipose tissue mass", unit: "g" },
  { label: "Visceral Adipose Tissue Volume (cm³)", marker: "Visceral adipose tissue volume", unit: "cm³" },
  { label: "Subcutaneous Adipose Tissue Area (cm²)", marker: "Subcutaneous adipose tissue area", unit: "cm²" },
  { label: "Total body % Lean", marker: "Total body % Lean", unit: "%" },
  { label: "Lean mass/height² (kg/m²)", marker: "Lean mass index (LMI)", unit: "kg/m²" },
  { label: "Append. Lean Mass/Height² (kg/m²)", marker: "Appendicular lean mass index (ALMI)", unit: "kg/m²" },
  { label: "Total body % Bone", marker: "Total body % Bone", unit: "%" },
  { label: "BMC/Height² (g/m²)", marker: "BMC/height²", unit: "g/m²" },
];

const ROIS_BC = [
  "Left Arm", "Right Arm", "Left Ribs", "Right Ribs", "T Spine", "L Spine",
  "Pelvis", "Left Leg", "Right Leg", "SubTotal", "Head", "Total", "Android", "Gynoid",
];
const BC_COLUMNS: { x: number; metric: string; unit: string }[] = [
  { x: 83, metric: "% Fat", unit: "%" },
  { x: 135, metric: "Tissue mass", unit: "g" },
  { x: 190, metric: "Tissue area", unit: "cm²" },
  { x: 247, metric: "Fat", unit: "g" },
  { x: 300, metric: "Lean", unit: "g" },
  { x: 354, metric: "BMC", unit: "g" },
  { x: 408, metric: "BMC area", unit: "cm²" },
  { x: 467, metric: "Total mass", unit: "kg" },
];

const ROIS_BMD = [
  "Left Arm", "Right Arm", "Left Ribs", "Right Ribs", "T Spine", "L Spine",
  "Pelvis", "Left Leg", "Right Leg", "Total", "Head",
];
const BMD_COLUMNS: { x: number; metric: string; unit: string }[] = [
  { x: 130, metric: "BMD", unit: "g/cm²" },
  { x: 214, metric: "BMC", unit: "g" },
  { x: 301, metric: "Bone area", unit: "cm²" },
];

function parseEuropeanDate(s: string): string | undefined {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return undefined;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function findValueAt(page: Page, x: number, y: number, tol = 3): number | undefined {
  let best: { d: number; v: number } | undefined;
  for (const it of page) {
    if (Math.abs(it.y - y) > tol) continue;
    if (Math.abs(it.x - x) > 12) continue;
    const n = parseFloat(it.str.replace(/,/g, ""));
    if (!isFinite(n)) continue;
    const d = Math.abs(it.x - x);
    if (!best || d < best.d) best = { d, v: n };
  }
  return best?.v;
}

function findLabelY(page: Page, label: string, xMin: number, xMax: number): number | undefined {
  for (const it of page) {
    if (it.x < xMin || it.x > xMax) continue;
    if (it.str.trim() === label) return it.y;
  }
  return undefined;
}

function findScanDate(pages: Page[]): string | undefined {
  for (const page of pages) {
    for (const it of page) {
      if (!it.str.startsWith("Scan Date")) continue;
      for (const v of page) {
        if (Math.abs(v.y - it.y) > 2) continue;
        if (v.x <= it.x) continue;
        const d = parseEuropeanDate(v.str);
        if (d) return d;
      }
    }
  }
  return undefined;
}

function findScalar(pages: Page[], label: string): number | undefined {
  for (const it of pages.flat()) {
    if (it.str === label) {
      for (const v of pages.flat()) {
        if (Math.abs(v.y - it.y) > 2) continue;
        if (v.x <= it.x + 20) continue;
        const n = parseFloat(v.str.replace(/,/g, ""));
        if (isFinite(n)) return n;
      }
    }
  }
  return undefined;
}

function findTScoreZScore(pages: Page[]): { t?: number; z?: number } {
  const out: { t?: number; z?: number } = {};
  for (const it of pages.flat()) {
    const s = it.str.trim();
    let m = s.match(/^T-score\s*:\s*(-?\d+(?:\.\d+)?)/i);
    if (m) out.t = parseFloat(m[1]);
    m = s.match(/^Z-score\s*:\s*(-?\d+(?:\.\d+)?)/i);
    if (m) out.z = parseFloat(m[1]);
  }
  return out;
}

export async function parseDexa(bytes: Uint8Array): Promise<MarkerResult[]> {
  // isEvalSupported:false is a real pdfjs runtime option (disables eval), just missing from the
  // legacy build's DocumentInitParameters typing — cast to the param type to keep it.
  const pdf = await getDocument({ data: bytes, isEvalSupported: false } as Parameters<typeof getDocument>[0]).promise;
  const pages: Page[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items: Page = [];
    for (const it of content.items) {
      if (!("str" in it)) continue;
      const t = it.transform as number[];
      const s = it.str as string;
      if (!s.trim()) continue;
      items.push({ str: s, x: Math.round(t[4]), y: Math.round(t[5]) });
    }
    pages.push(items);
  }
  return extractDexaMarkers(pages);
}

/**
 * The whole parse, given already-extracted page text. `parseDexa` is the pdfjs adapter around it.
 *
 * Throws when the scan date is missing rather than dating the markers "today": a body-composition
 * reading filed under the wrong date is worse than a failed import, because the trend line it joins
 * is what a clinician reads.
 */
export function extractDexaMarkers(pages: Page[]): MarkerResult[] {
  const date = findScanDate(pages);
  if (!date) throw new Error("Scan Date not found in PDF");

  const out: MarkerResult[] = [];
  const add = (marker: string, group: string, value: number, unit: string) => {
    out.push({ marker, group, source: "Scan", date, value, unit });
  };

  const page1 = pages[0];
  const page2 = pages[1] ?? [];

  for (const idx of COMPOSITION_INDICES) {
    const y = findLabelY(page1, idx.label, 340, 360);
    if (y === undefined) continue;
    const v = findValueAt(page1, 537, y, 3);
    if (v !== undefined) add(idx.marker, GROUP_BC_TOTAL, v, idx.unit);
  }

  for (const roi of ROIS_BC) {
    const y = findLabelY(page1, roi, 0, 60);
    if (y === undefined) continue;
    for (const col of BC_COLUMNS) {
      const v = findValueAt(page1, col.x, y, 3);
      if (v !== undefined) add(`${roi} ${col.metric}`, GROUP_BC_REGION, v, col.unit);
    }
  }

  for (const roi of ROIS_BMD) {
    const y = findLabelY(page2, roi, 0, 60);
    if (y === undefined) continue;
    for (const col of BMD_COLUMNS) {
      const v = findValueAt(page2, col.x, y, 3);
      if (v !== undefined) add(`${roi} ${col.metric}`, GROUP_BMD_REGION, v, col.unit);
    }
  }

  const tz = findTScoreZScore(pages);
  if (tz.t !== undefined) add("Whole body T-score", GROUP_BMD, tz.t, "");
  if (tz.z !== undefined) add("Whole body Z-score", GROUP_BMD, tz.z, "");

  const height = findScalar(pages, "Height :");
  const weight = findScalar(pages, "Weight :");
  if (height !== undefined) add("Height", "Anthropometrics", height, "cm");
  if (weight !== undefined) add("Weight", "Anthropometrics", weight, "kg");

  return out;
}

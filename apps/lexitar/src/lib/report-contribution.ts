// W15/0c — the pure ProposedReport → (diseases, markerRows, telemetry) mapping,
// lifted verbatim out of scripts/ingest.ts:importReportsFor so the browser fold
// and the CLI share one implementation. Takes an extraction + the source id + the
// client (for the prior-comparison cross-check); returns everything the caller
// needs to fold (applyReportContribution) and to log/preview identically.
import type { Client, MarkerResult } from "./types";
import { canonicalImagingMarker, isKnownImagingMarker } from "@pablotech/akesi-pil/imaging-catalog";
import type { ProposedReport } from "@pablotech/akesi-pil/report-extract";

// Extracted items below this confidence are still ingested, but surfaced for the
// operator/user to review rather than silently trusted.
export const CONF_REVIEW = 0.5;

// A stated prior value that disagrees with a reading already in the vault.
export interface PriorMismatch {
  marker: string;
  priorValue: number;
  priorDate: string;
  realValue: number;
  unit: string;
}

// Per-item detail so a caller renders identical CLI logs / a web preview without
// recomputing canonical names or the vault cross-check.
export interface MarkerLogItem {
  date: string;
  name: string;
  value: number;
  unit: string;
  confidence: number;
}
export interface PriorLogItem {
  priorDate: string;
  name: string;
  priorValue: number;
  unit: string;
  currentValue: number;
  tag: string;
  confidence: number;
}

export interface ReportContribution {
  // r.diseases[0]?.date ?? r.markers[0]?.date ?? "" — the study date used for the
  // stored filename and comorbidity dating.
  studyDate: string;
  // Ready to pass to applyReportContribution: the report's own findings plus the
  // header comorbidities folded in (tagged with their ICD code).
  diseases: { date: string; diagnostic: string; summary?: string; icdCodes?: string[] }[];
  markerRows: MarkerResult[];
  // Telemetry the caller aggregates across a batch.
  unknownMarkers: Map<string, number>;
  priorMismatches: PriorMismatch[];
  lowConfidence: number;
  markerLog: MarkerLogItem[];
  priorLog: PriorLogItem[];
}

// Two readings of the same measurement agree within ~1% (with a small absolute
// floor) — used to decide whether a report's stated prior matches the vault.
function valuesClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01 * Math.max(Math.abs(a), Math.abs(b), 1);
}

export function reportContribution(client: Client, id: string, r: ProposedReport): ReportContribution {
  const studyDate = r.diseases[0]?.date ?? r.markers[0]?.date ?? "";
  const markerRows: MarkerResult[] = [];
  const unknownMarkers = new Map<string, number>();
  const priorMismatches: PriorMismatch[] = [];
  const markerLog: MarkerLogItem[] = [];
  const priorLog: PriorLogItem[] = [];
  let lowConfidence = 0;

  for (const d of r.diseases) if (d.confidence < CONF_REVIEW) lowConfidence++;

  // Header comorbidities — standing problem-list diagnoses, dated to the study,
  // folded into the disease list (tagged with their ICD code). Keep the report's
  // fuller descriptor as the summary only when it adds something over the label.
  const comorbidityDiseases = (r.comorbidities ?? []).map((c) => {
    const desc = c.description?.trim();
    const summary = desc && desc !== c.label.trim() ? desc : undefined;
    return { date: studyDate, diagnostic: c.label, icdCodes: c.code ? [c.code] : [], summary };
  });
  for (const c of r.comorbidities ?? []) if (c.confidence < CONF_REVIEW) lowConfidence++;

  for (const m of r.markers) {
    const name = canonicalImagingMarker(m.marker);
    if (!isKnownImagingMarker(m.marker)) unknownMarkers.set(name, (unknownMarkers.get(name) ?? 0) + 1);
    if (m.confidence < CONF_REVIEW) lowConfidence++;
    markerLog.push({ date: m.date, name, value: m.value, unit: m.unit, confidence: m.confidence });
    markerRows.push({ marker: name, group: m.group, source: "Imaging", date: m.date, value: m.value, unit: m.unit, sourceId: id });
  }

  // Prior-comparison capture — materialize each "vs prior" statement as a dated
  // placeholder reading so it joins the marker's series. A real reading at the
  // same marker|date always wins (merge rules in report-merge.ts); when one is
  // already present, cross-check the stated prior against it.
  for (const pc of r.priorComparisons ?? []) {
    const name = canonicalImagingMarker(pc.marker);
    if (!isKnownImagingMarker(pc.marker)) unknownMarkers.set(name, (unknownMarkers.get(name) ?? 0) + 1);
    const real = client.results.find((x) => x.marker === name && x.date === pc.priorDate && !x.fromComparison);
    if (pc.confidence < CONF_REVIEW) lowConfidence++;
    const tag = !real ? "new prior point" : valuesClose(real.value, pc.priorValue) ? "matches vault" : `MISMATCH — vault has ${real.value}${real.unit ? " " + real.unit : ""}`;
    priorLog.push({ priorDate: pc.priorDate, name, priorValue: pc.priorValue, unit: pc.unit, currentValue: pc.currentValue, tag, confidence: pc.confidence });
    if (real && !valuesClose(real.value, pc.priorValue)) {
      priorMismatches.push({ marker: name, priorValue: pc.priorValue, priorDate: pc.priorDate, realValue: real.value, unit: pc.unit });
    }
    const group = markerRows.find((mr) => mr.marker === name)?.group ?? "Imaging";
    markerRows.push({ marker: name, group, source: "Imaging", date: pc.priorDate, value: pc.priorValue, unit: pc.unit, sourceId: id, fromComparison: true });
  }

  const diseases = [
    ...r.diseases.map((d) => ({ date: d.date, diagnostic: d.diagnostic, summary: d.summary })),
    ...comorbidityDiseases,
  ];

  return { studyDate, diseases, markerRows, unknownMarkers, priorMismatches, lowConfidence, markerLog, priorLog };
}

// Egress helpers (W11e). CSV moved verbatim from App.svelte; JSON is a new
// structured slice. Email/share is W9c (PHI-crossing, gated by W8e) — not here.

import type { Vault } from "./types";
import { displayScaleFor } from "./units";

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvField(s: string | number | undefined): string {
  if (s === undefined || s === null) return "";
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * The CSV text. Separated from the download in W72 so it can be tested: this is the artefact DPGA
 * Indicator 6 (non-PII data extraction in a non-proprietary format) actually rests on, and it was
 * cited as evidence while having no test coverage at all.
 */
export function buildCsv(v: Vault, system: "metric" | "imperial"): string {
  const cols = ["client", "source", "group", "marker", "date", "value", "unit", "ref_low", "ref_high", "watched"];
  const lines: string[] = [cols.join(",")];
  for (const [, client] of Object.entries(v.clients).sort((a, b) =>
    a[1].displayName.localeCompare(b[1].displayName),
  )) {
    const watched = new Set(client.watchlist);
    const markerMaxG = new Map<string, number>();
    for (const r of client.results) {
      if (r.unit === "g") {
        markerMaxG.set(r.marker, Math.max(markerMaxG.get(r.marker) ?? 0, Math.abs(r.value)));
      }
    }
    const sorted = [...client.results].sort((a, b) =>
      a.marker === b.marker ? a.date.localeCompare(b.date) : a.marker.localeCompare(b.marker),
    );
    for (const r of sorted) {
      let value = r.value;
      let unit = r.unit;
      let refLow = r.ref?.low;
      let refHigh = r.ref?.high;
      // One conversion step covers physical (g→kg auto-scale + imperial) AND analyte
      // (mg/dL↔mmol/L, …) for the chosen system, keyed by marker. Stored value untouched.
      const maxAbs = Math.max(markerMaxG.get(r.marker) ?? 0, Math.abs(value));
      const { scale, unit: dispUnit } = displayScaleFor(r.marker, unit, maxAbs, system);
      value *= scale;
      if (refLow != null) refLow *= scale;
      if (refHigh != null) refHigh *= scale;
      unit = dispUnit;
      lines.push([
        csvField(client.displayName),
        csvField(r.source),
        csvField(r.group),
        csvField(r.marker),
        csvField(r.date),
        csvField(r.valueText ?? value),
        csvField(unit),
        csvField(refLow),
        csvField(refHigh),
        csvField(watched.has(r.marker) ? "true" : "false"),
      ].join(","));
    }
  }
  return lines.join("\n");
}

export function exportCsv(v: Vault, system: "metric" | "imperial", today: string): void {
  download(new Blob([buildCsv(v, system)], { type: "text/csv" }), `health-${today}-${system}.csv`);
}

// A machine-readable structured slice of the whole vault (demographics, factors,
// watchlist, results, finding). Pretty-printed so a clinician's system or a human
// can read it. Encryption/secret material never leaves — this is the decrypted view.
/** The JSON payload. Separated from the download for the same reason as buildCsv. */
export function buildJson(v: Vault, today: string): unknown {
  return {
    exportedAt: today,
    clients: Object.entries(v.clients)
      .sort((a, b) => a[1].displayName.localeCompare(b[1].displayName))
      .map(([id, c]) => ({
        id,
        displayName: c.displayName,
        gender: c.gender,
        dob: c.dob,
        factors: c.factors ?? {},
        watchlist: c.watchlist,
        results: c.results,
        finding: c.finding ?? null,
      })),
  };
}

export function exportJson(v: Vault, today: string): void {
  download(new Blob([JSON.stringify(buildJson(v, today), null, 2)], { type: "application/json" }), `health-${today}.json`);
}

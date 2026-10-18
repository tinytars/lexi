// W16 — the one chat tool: get_marker_readings. The vault is decrypted only in the browser,
// so /api/chat never holds the data; it relays Claude's tool-use loop and the browser executes
// the tool locally against its Client. runMarkerTool is pure and unit-tested.

import type { Client } from "./types";
import { convertForDisplay, type UnitSystem } from "./units";

export interface MarkerToolInput {
  markers: string[];
  from?: string;
  to?: string;
}

export interface MarkerToolResult {
  marker: string;
  rows: { date: string; value: number; unit: string; valueText?: string }[];
  note?: string;
}

// Anthropic tool definition. The model picks marker names verbatim from the context catalog.
export const GET_MARKER_READINGS_TOOL = {
  name: "get_marker_readings",
  description:
    "Fetch the full reading history for one or more markers from the patient's record. Use this " +
    "for specific historical values or a date range (e.g. 'what was my B12 on 2025-10-04?'). Pass " +
    "marker names exactly as they appear in the context catalog, and batch every marker a question " +
    "needs into a single call. Answer latest-value or overall questions from the catalog without a call.",
  input_schema: {
    type: "object" as const,
    properties: {
      markers: {
        type: "array",
        items: { type: "string" },
        description: "Marker names, verbatim from the catalog.",
      },
      from: { type: "string", description: "Optional inclusive ISO start date (YYYY-MM-DD)." },
      to: { type: "string", description: "Optional inclusive ISO end date (YYYY-MM-DD)." },
    },
    required: ["markers"],
  },
};

const MAX_MARKERS = 20;
const MAX_ROWS_PER_MARKER = 100;

// Pure executor. Matches marker names case-insensitively (the catalog gives exact names, but the
// model occasionally recases), filters by an optional date range, converts each reading to the
// chosen unit system (so tool numbers match the catalog + grid), and returns an empty rows + note
// for an unknown marker so the model can self-correct from the catalog.
export function runMarkerTool(client: Client, input: MarkerToolInput, system: UnitSystem = "imperial"): MarkerToolResult[] {
  const markers = Array.isArray(input.markers) ? input.markers.slice(0, MAX_MARKERS) : [];
  const from = input.from;
  const to = input.to;
  const byLower = new Map<string, Client["results"]>();
  for (const r of client.results) {
    const k = r.marker.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, []);
    byLower.get(k)!.push(r);
  }
  return markers.map((name) => {
    const matches = byLower.get(name.toLowerCase());
    if (!matches) return { marker: name, rows: [], note: "unknown marker — not in this record" };
    const rows = matches
      .filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, MAX_ROWS_PER_MARKER)
      .map((r) => {
        const c = r.valueText ? { value: r.value, unit: r.unit } : convertForDisplay(r.marker, r.unit, r.value, system);
        return { date: r.date, value: c.value, unit: c.unit, ...(r.valueText ? { valueText: r.valueText } : {}) };
      });
    return { marker: matches[0].marker, rows };
  });
}

// The compact patient slice the chat panel hands to /api/chat. Mirrors the Finding's
// inputs in spirit (markers+deltas, comorbidities, treatment, the synthesized Finding
// narrative) but trimmed to what a follow-on question needs — not the whole Client.
// Reuses markerDeltas (W2) so on-screen deltas and chat deltas can't disagree.

import { ageYears } from "@pablotech/akesi/ranges";
import type { Client, DiseaseEntry } from "./types";
import { markerDeltas, type DeltaChange } from "@pablotech/akesi/marker-deltas";
import { convertForDisplay, displayScaleFor, type UnitSystem } from "./units";
import { treatmentsOf } from "@pablotech/akesi/treatment-normalize";
import { bucketOf, collapseByName, groupByName, todayISODate, formatDose } from "@pablotech/akesi/treatment-bucket";
import { dailyTotalsByName, type IngredientTotal } from "./treatment-conclusion";
import type { ReferenceKind } from "./reference-resolver";

export interface MarkerCatalogEntry {
  marker: string;
  count: number;
  firstDate: string;
  lastDate: string;
  latest: { value: number; date: string; unit: string; valueText?: string };
  watchlisted: boolean;
}

export interface ChatContext {
  // Here rather than in the system prompt: the prompt is cached prefix, this block is not (CORPUS.md).
  today: string;
  patient: { name: string; age: number | null; gender: string };
  diseases: { diagnostic: string; icdCodes?: string[]; summary?: string }[];
  // The unified treatment list, titration collapsed, each tagged with its temporal bucket
  // (past / ongoing / planned) so the model reasons about timing without re-deriving it.
  treatments: {
    name: string;
    dose?: string;
    kind?: string;
    start: string;
    end?: string;
    bucket: string;
    // Present only when this medicine has more than one concurrently-ongoing row (e.g. an AM row
    // and a PM row) — one entry per ongoing row, so the model can answer a timing-specific
    // question ("how much do I take in the morning") instead of only seeing the collapsed `dose`.
    doses?: { timingPeriod?: "AM" | "PM"; dose?: string }[];
    // The same computed total treatment-conclusion.ts shows the UI as "Daily total" — summed
    // across every currently-ongoing row of this medicine (an AM row and a PM row both count).
    // Present only when administration+ingredient data actually supports a real number.
    dailyTotal?: IngredientTotal[];
  }[];
  watchlist: string[];
  // W16 — a lean catalog (one row per marker: how many readings, the date span, the latest
  // value) rather than the full per-marker history. Latest-value / "how am I doing" questions
  // answer from this; specific historical values are fetched on demand via the get_marker_readings
  // tool (chat-tools.ts), so the ~40k-token readings dump no longer rides every turn.
  catalog: MarkerCatalogEntry[];
  deltas: {
    marker: string;
    unit: string;
    latest: { value: number; date: string };
    vsPrior: DeltaChange;
    vsBaseline?: DeltaChange;
  }[];
  finding?: {
    progression?: { latest: string; recent: string; overall: string };
    clinicalSynthesis?: { adverse: string; favorable: string; conditioning?: string };
    criticalRatios?: { name: string; meaning: string }[];
  };
  // M69 — pasted reference-card turns, live re-resolved and folded in by send() (ChatTab.svelte)
  // before JSON.stringify; not computed here, buildChatContext has no access to the thread's turns.
  references?: { kind: ReferenceKind; tag: string; title: string; data: unknown }[];
}

function diseases(items?: DiseaseEntry[]) {
  return (items ?? []).map((d) => ({
    diagnostic: d.diagnostic,
    ...(d.icdCodes ? { icdCodes: d.icdCodes } : {}),
    ...(d.summary ? { summary: d.summary } : {}),
  }));
}

// One row per marker: reading count, date span, and the latest value (converted to the chosen
// unit system so chat numbers match the grid; the LLM does no arithmetic). The full series is not
// carried — the model fetches specific readings on demand via get_marker_readings (chat-tools.ts).
function markerCatalog(client: Client, system: UnitSystem, watchlist: string[]): MarkerCatalogEntry[] {
  const byMarker = new Map<string, typeof client.results>();
  for (const r of client.results) {
    if (!byMarker.has(r.marker)) byMarker.set(r.marker, []);
    byMarker.get(r.marker)!.push(r);
  }
  const wl = new Set(watchlist);
  return [...byMarker.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([marker, rows]) => {
      const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
      const last = sorted[sorted.length - 1];
      const c = last.valueText ? { value: last.value, unit: last.unit } : convertForDisplay(marker, last.unit, last.value, system);
      return {
        marker,
        count: sorted.length,
        firstDate: sorted[0].date,
        lastDate: last.date,
        latest: {
          value: c.value,
          date: last.date,
          unit: c.unit,
          ...(last.valueText ? { valueText: last.valueText } : {}),
        },
        watchlisted: wl.has(marker),
      };
    });
}

// Convert a DeltaChange's absolute change by `scale` (percent/direction/span are scale-invariant).
function scaleDelta(c: DeltaChange, scale: number): DeltaChange {
  return { ...c, abs: c.abs * scale };
}

export function buildChatContext(client: Client, system: UnitSystem = "imperial"): ChatContext {
  const f = client.factors;
  const watchlist = [...client.watchlist].sort();
  const today = todayISODate();
  const rawTreatments = treatmentsOf(client);
  const groupByKey = new Map(groupByName(rawTreatments, today).map((g) => [g.name.trim().toLowerCase(), g]));
  const dailyTotals = dailyTotalsByName(rawTreatments, today);
  const ctx: ChatContext = {
    today,
    patient: { name: client.displayName, age: ageYears(client.dob), gender: client.gender },
    diseases: diseases(f?.diseases),
    treatments: collapseByName(rawTreatments).map((t) => {
      const row: ChatContext["treatments"][number] = { name: t.name, start: t.start, bucket: bucketOf(t, today) };
      const dose = formatDose(t);
      if (dose) row.dose = dose;
      if (t.kind) row.kind = t.kind;
      if (t.end) row.end = t.end;
      const key = t.name.trim().toLowerCase();
      const group = groupByKey.get(key);
      if (group) {
        const ongoingRows = group.rows.filter((r) => bucketOf(r, today) === "ongoing");
        // Only break out by timing when every ongoing row is genuinely concurrent (each carries its
        // own timingPeriod) — same signal splitByTiming() uses elsewhere (treatment-bucket.ts) to
        // tell a real AM+PM split apart from a titration row simply left without an `end` date.
        if (ongoingRows.length > 1 && ongoingRows.every((r) => r.timingPeriod)) {
          row.doses = ongoingRows.map((r) => ({ timingPeriod: r.timingPeriod, dose: formatDose(r) }));
        }
      }
      const total = dailyTotals.get(key);
      if (total) row.dailyTotal = total;
      return row;
    }),
    watchlist,
    catalog: markerCatalog(client, system, watchlist),
    deltas: markerDeltas(client).map((d) => {
      // The delta is in d.unit (stored, or canonical for a mixed series). Convert to the
      // chosen system; scale the abs change by the same factor so it matches the readings.
      const { scale, unit } = displayScaleFor(d.marker, d.unit, Math.abs(d.latest.value), system);
      return {
        marker: d.marker,
        unit: d.latest.valueText ? d.unit : unit,
        latest: { value: d.latest.valueText ? d.latest.value : d.latest.value * scale, date: d.latest.date },
        vsPrior: scaleDelta(d.vsPrior, scale),
        ...(d.vsBaseline ? { vsBaseline: scaleDelta(d.vsBaseline, scale) } : {}),
      };
    }),
  };
  const fi = client.finding;
  if (fi) {
    ctx.finding = {
      progression: fi.progression,
      ...(fi.clinicalSynthesis ? { clinicalSynthesis: fi.clinicalSynthesis } : {}),
      ...(fi.criticalRatios
        ? { criticalRatios: fi.criticalRatios.map((r) => ({ name: r.name, meaning: r.meaning })) }
        : {}),
    };
  }
  return ctx;
}

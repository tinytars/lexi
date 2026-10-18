import type { Client } from "./types";

export interface Pair { label: string; detail: string; result?: string; group?: string }

// Shared with Study.svelte's own read (patient) model and SearchPanel's study resolver, so both
// build the exact same patient-row/AI-result pairing from one source of truth.
export function buildStudyPairs(client: Client): Pair[] {
  const study = client.study ?? {};
  const results = client.finding?.studyResults ?? [];
  const byLabel = new Map(results.map((r) => [r.study, r]));
  const rows: Pair[] = [];
  const push = (label: string, detail: string) => {
    const r = byLabel.get(label);
    rows.push({ label, detail, result: r?.result, group: r?.group });
  };
  for (const e of study.entries ?? []) push(e.focus, e.detail);
  const seen = new Set(rows.map((r) => r.label));
  for (const r of results) if (!seen.has(r.study)) rows.push({ label: r.study, detail: "", result: r.result, group: r.group });
  return rows;
}

// W21 — resolve the Finding's AI-generated treatmentGroups (verbatim refs) into displayable items for
// Future Treatment. `patient` refs match a factors.decisions intervention (first) or a factors.plan
// action (dual-source); `ai` refs match a finding.decisions.ai intervention. Unresolved refs are
// dropped defensively. resolveTreatmentGroups returns null when the Finding has no treatmentGroups
// (a pre-W21 Finding) — the signal for FutureTreatment to fall back to its heuristic.

import type { Client, TreatmentGroup } from "./types";
import { treatmentsOf } from "@pablotech/akesi-pil/treatment-normalize";
import { bucketOf, treatmentLabel, todayISODate } from "@pablotech/akesi-pil/treatment-bucket";
import { systemOrder, UNCATEGORIZED } from "@pablotech/akesi-pil/system-groups";
import { sortPinnedFirst } from "./pin-sort";

export interface ResolvedPatientItem {
  kind: "decision" | "plan";
  id: string;
  pinned: boolean;
  label: string;
  purpose?: string; // decisions only
  date?: string; // plan only
}
export interface ResolvedAiItem {
  intervention: string;
  purpose: string;
}
export interface ResolvedGroup {
  system: string;
  topic: string;
  patient: ResolvedPatientItem[];
  ai: ResolvedAiItem[];
}

export function resolvePatientRef(client: Client, ref: string): ResolvedPatientItem | null {
  const t = (ref ?? "").trim();
  const dec = (client.factors?.decisions ?? []).find((d) => d.intervention.trim() === t);
  if (dec) return { kind: "decision", id: dec.id, pinned: dec.pinned === true, label: dec.intervention, purpose: dec.purpose };
  const today = todayISODate();
  const planned = treatmentsOf(client).find((x) => bucketOf(x, today) === "planned" && treatmentLabel(x) === t);
  if (planned) return { kind: "plan", id: planned.id, pinned: planned.pinned === true, label: treatmentLabel(planned), date: planned.start };
  return null;
}

export function resolveAiRef(client: Client, ref: string): ResolvedAiItem | null {
  const t = (ref ?? "").trim();
  const ai = (client.finding?.decisions?.ai ?? []).find((d) => d.intervention.trim() === t);
  return ai ? { intervention: ai.intervention, purpose: ai.purpose } : null;
}

// W25 — map each committed Plan action (verbatim label) to its body system, derived from the
// Finding's treatmentGroups (every plan action is a `patient` ref there, tagged with a system).
// Lets Treatment Plan group by System Analysis with no schema change. Empty map (→ flat fallback)
// when the Finding predates treatmentGroups.
export function planActionSystems(client: Client): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of client.finding?.treatmentGroups ?? []) {
    if (!g.system) continue;
    for (const ref of g.patient) {
      const resolved = resolvePatientRef(client, ref);
      if (resolved?.kind === "plan") m.set(resolved.label.trim(), g.system);
    }
  }
  return m;
}

export function resolveTreatmentGroups(client: Client): ResolvedGroup[] | null {
  const groups: TreatmentGroup[] | undefined = client.finding?.treatmentGroups;
  if (!groups) return null;
  return groups.map((g) => ({
    system: g.system ?? "",
    topic: g.topic,
    patient: g.patient.map((r) => resolvePatientRef(client, r)).filter((x): x is ResolvedPatientItem => x !== null),
    ai: g.ai.map((r) => resolveAiRef(client, r)).filter((x): x is ResolvedAiItem => x !== null),
  }));
}

// M103 — relocated verbatim from HypothesisTopicCard.svelte's module script: search-index.ts is
// plain .ts, plain-vitest with no Svelte plugin, so it can't value-import from a .svelte module
// script. Shared with FutureTreatment.svelte's own read (patient) model and SearchPanel's
// hypothesis resolver, so both build the exact same system-defaulted/decision-filtered/
// pinned-sorted/system-ordered groups from one source of truth.
export function buildHypothesisGroups(client: Client): ResolvedGroup[] | null {
  const raw = resolveTreatmentGroups(client);
  if (!raw) return null;
  const g = raw
    .map((x) => ({ ...x, system: x.system || UNCATEGORIZED, patient: sortPinnedFirst(x.patient.filter((p) => p.kind === "decision")) }))
    .filter((x) => x.patient.length > 0 || x.ai.length > 0);
  const order = systemOrder(client);
  const rank = (s: string) => {
    const i = order.indexOf(s);
    return i < 0 ? order.length : i;
  };
  return [...g].sort((a, b) => rank(a.system) - rank(b.system));
}

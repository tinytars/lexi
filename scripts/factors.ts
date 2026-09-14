import { randomUUID } from "node:crypto";
import { sha256hex12 as hash12 } from "@pablotech/neuro-pil/hash-node";
import { driftedKeys, isStamped } from "@pablotech/neuro-pil";
import type { Client, ClientFactors, DecisionEntry, StudyEntry, TreatmentItem } from "../src/lib/types";
import { factorsCanonicalString, findingInputsCanonicalString } from "../src/lib/factors-hash";
import { nodeInputCanonical } from "../src/lib/node-input-hash";
import { findingDag } from "../src/lib/finding-dag";
import { LEAF_REGEN_SPECS } from "../src/lib/leaf-regen-registry";
import { capFirst, PREGNANCY_VALUES, ATHLETIC_VALUES, SMOKING_VALUES } from "@pablotech/akesi-pil/factors-edit";
import { endOfMonth } from "@pablotech/akesi-pil/dates";

export { capFirst };

export function factorsHashOf(client: Client): string {
  return hash12(factorsCanonicalString(client));
}

export function findingInputsHashOf(client: Client): string {
  return hash12(findingInputsCanonicalString(client));
}

// W15b — the per-node input hashes stamped onto the Finding at generation, mirroring the browser's
// staleNodes. Same canonicalizer both sides, so the two agree byte-for-byte.
export function nodeHashesOf(client: Client): Record<string, string> {
  const out: Record<string, string> = {};
  // Projections (e.g. markerGroups) are self-hashed and regenerated out-of-band — not part of the
  // Finding's stamp. Only source/derived/leaf nodes participate in finding.nodeHashes staleness.
  for (const n of findingDag.nodes) if (isStamped(n)) out[n.key] = hash12(nodeInputCanonical(client, n.key));
  return out;
}

// CLI-side staleNodes (node:crypto), mirror of src/lib/staleness.ts. Empty for a pre-W15b finding
// that carries no nodeHashes — the caller falls back to the monolithic inputsHash.
export function staleNodesOf(client: Client): Set<string> {
  const stamped = client.finding?.nodeHashes;
  if (!stamped) return new Set();
  return new Set(driftedKeys(nodeHashesOf(client), stamped));
}

// W15d — leaves that can be regenerated on their own (from the stored core outputs), skipping the
// ~$5 monolithic call. Derived from LEAF_REGEN_SPECS rather than listed by hand: W65 made the core
// prompt stop writing these sections entirely, so anything with a spec is regenerable BY DEFINITION,
// and a hand-list that lagged the registry sent a stale allergy or family-history edit to a full
// core regen it never needed. Adding a spec now adds it here.
export const LEAF_REGENERABLE: ReadonlySet<string> = new Set<string>(Object.keys(LEAF_REGEN_SPECS));
// Whole-report summaries that legitimately lag a leaf refresh — they don't force a core regen, but we
// never re-stamp them without regenerating (that would mark stale prose fresh — a safety no).
const TOLERANT_SUMMARIES = new Set<string>(["finalThoughts"]);

export type RefreshPlan =
  | { kind: "up-to-date" }
  | { kind: "leaf-only"; leaves: string[]; lagging: string[] }
  | { kind: "summaries-lagging"; lagging: string[] }
  | { kind: "full"; reason: string };

// Decide how to refresh a Finding: skip it, regen just the cheap leaves, note lagging summaries, or
// do the full core regen. Pure — the executor (ingest.ts) acts on the verdict.
export function planFindingRefresh(client: Client, force: boolean): RefreshPlan {
  if (force) return { kind: "full", reason: "forced" };
  if (!client.finding) return { kind: "full", reason: "no existing finding" };
  if (!client.finding.nodeHashes) return { kind: "full", reason: "pre-W15b finding (no per-node hashes)" };
  const stale = staleNodesOf(client);
  if (stale.size === 0) return { kind: "up-to-date" };
  const leaves = [...stale].filter((k) => LEAF_REGENERABLE.has(k));
  const lagging = [...stale].filter((k) => TOLERANT_SUMMARIES.has(k));
  const blocking = [...stale].filter((k) => !LEAF_REGENERABLE.has(k) && !TOLERANT_SUMMARIES.has(k));
  if (blocking.length > 0) return { kind: "full", reason: `stale nodes need the core: ${blocking.join(", ")}` };
  if (leaves.length > 0) return { kind: "leaf-only", leaves, lagging };
  return { kind: "summaries-lagging", lagging };
}

const FACTOR_KEYS: ReadonlyArray<keyof ClientFactors> = [
  "pregnancy", "athletic", "bmi", "height", "smoking", "ethnicity", "goal", "focus",
];

export function setFactor(client: Client, key: string, raw: string): void {
  if (!FACTOR_KEYS.includes(key as keyof ClientFactors)) {
    throw new Error(`unknown factor "${key}". Valid: ${FACTOR_KEYS.join(", ")}`);
  }
  client.factors ??= {};
  const f = client.factors;
  switch (key) {
    case "pregnancy":
      if (!(PREGNANCY_VALUES as readonly string[]).includes(raw)) {
        throw new Error(`pregnancy must be one of: ${PREGNANCY_VALUES.join(", ")}`);
      }
      f.pregnancy = raw as ClientFactors["pregnancy"];
      break;
    case "athletic":
      if (!(ATHLETIC_VALUES as readonly string[]).includes(raw)) {
        throw new Error(`athletic must be one of: ${ATHLETIC_VALUES.join(", ")}`);
      }
      f.athletic = raw as ClientFactors["athletic"];
      break;
    case "smoking":
      if (!(SMOKING_VALUES as readonly string[]).includes(raw)) {
        throw new Error(`smoking must be one of: ${SMOKING_VALUES.join(", ")}`);
      }
      f.smoking = raw as ClientFactors["smoking"];
      break;
    case "bmi": {
      const n = Number(raw);
      if (!isFinite(n) || n <= 0) throw new Error(`bmi must be a positive number`);
      f.bmi = n;
      break;
    }
    case "height":
      f.height = raw.trim();
      break;
    case "ethnicity":
      f.ethnicity = capFirst(raw);
      break;
    case "goal":
      f.goal = capFirst(raw);
      break;
    case "focus":
      f.focus = capFirst(raw);
      break;
  }
}

export function addTreatment(client: Client, item: Omit<TreatmentItem, "id" | "pinned">): void {
  client.factors ??= {};
  client.factors.treatments ??= [];
  const entry: TreatmentItem = { id: randomUUID(), name: capFirst(item.name), start: endOfMonth((item.start ?? "").trim()) };
  const dose = (item.dose ?? "").trim();
  if (dose) entry.dose = dose;
  if (item.kind) entry.kind = item.kind;
  const end = endOfMonth((item.end ?? "").trim());
  if (end) entry.end = end;
  client.factors.treatments.push(entry);
}

// W78 — UnifiedTreatment.svelte's medicine-scope save computes attachments from one row and fans it
// across every sibling row in the name-group, so different saves over time can leave a row's
// `rawCaptureAttachmentKeys` pointing at a photo its OWN `attachments` no longer carries — exactly
// what report-merge.ts's per-row provenance check reads. Scoped to that invariant, not a blanket
// union: a row gains an attachment only when the row ITSELF claims that key via
// rawCaptureAttachmentKeys and a sibling still has the object to source it from — an attachment
// neither row's provenance claims is left alone, so two rows that happen to differ for a legitimate
// reason (a photo attached directly to one entry, never claimed as raw capture) are untouched.
// Returns the number of attachments added, across every row.
export function reconcileTreatmentAttachments(client: Client, name?: string): number {
  const treatments = client.factors?.treatments;
  if (!treatments) return 0;
  const target = name ? capFirst(name).trim().toLowerCase() : undefined;
  const groups = new Map<string, TreatmentItem[]>();
  for (const t of treatments) {
    const key = t.name.trim().toLowerCase();
    if (target && key !== target) continue;
    const rows = groups.get(key);
    if (rows) rows.push(t);
    else groups.set(key, [t]);
  }
  let added = 0;
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const pool = new Map<string, NonNullable<TreatmentItem["attachments"]>[number]>();
    for (const t of rows) for (const a of t.attachments ?? []) pool.set(a.key, a);
    for (const t of rows) {
      if (t.extracted?.via !== "photo" || !t.rawCaptureAttachmentKeys?.length) continue;
      const have = new Set((t.attachments ?? []).map((a) => a.key));
      const missing = t.rawCaptureAttachmentKeys.filter((k) => !have.has(k) && pool.has(k));
      if (missing.length === 0) continue;
      t.attachments = [...(t.attachments ?? []), ...missing.map((k) => pool.get(k)!)];
      added += missing.length;
    }
  }
  return added;
}

export function removeTreatment(client: Client, name: string): void {
  if (!client.factors?.treatments) return;
  const v = capFirst(name);
  client.factors.treatments = client.factors.treatments.filter((t) => t.name !== v);
}

export function clearTreatments(client: Client): void {
  if (client.factors) client.factors.treatments = [];
}

// Disease mutations moved to src/lib/factors-edit.ts (pure, browser/Function-importable for
// the report-fold + future web ingest); re-exported here so the CLI's import path is unchanged.
export { addDisease, removeDiseasesBySourceId, removeDisease, clearDiseases } from "@pablotech/akesi-pil/factors-edit";

export function addDecision(client: Client, item: Omit<DecisionEntry, "id" | "pinned">): void {
  client.factors ??= {};
  client.factors.decisions ??= [];
  const intervention = capFirst(item.intervention);
  const purpose = capFirst(item.purpose);
  if (client.factors.decisions.some((d) => d.intervention === intervention)) {
    client.factors.decisions = client.factors.decisions.map((d) =>
      d.intervention === intervention ? { ...d, intervention, purpose } : d,
    );
    return;
  }
  client.factors.decisions.push({ id: randomUUID(), intervention, purpose });
}

export function removeDecision(client: Client, intervention: string): void {
  if (!client.factors?.decisions) return;
  const v = capFirst(intervention);
  client.factors.decisions = client.factors.decisions.filter((d) => d.intervention !== v);
}

export function clearDecisions(client: Client): void {
  if (client.factors) client.factors.decisions = [];
}

export function addStudy(client: Client, item: Omit<StudyEntry, "id" | "pinned">): void {
  client.study ??= {};
  client.study.entries ??= [];
  client.study.entries.push({ id: randomUUID(), focus: capFirst(item.focus), detail: capFirst(item.detail) });
}

export function clearStudies(client: Client): void {
  if (client.study) client.study.entries = [];
}

// Returns whether a ratio was actually removed, so the caller can distinguish "removed" from
// "no ratio by that name" for its own reporting; a missing criticalRatios list is the caller's
// call too (it wants a different message: "no ratios to remove from" vs. "none named X").
export function removeCriticalRatio(client: Client, name: string): boolean {
  const ratios = client.finding?.criticalRatios;
  if (!ratios) return false;
  const before = ratios.length;
  client.finding!.criticalRatios = ratios.filter((r) => r.name.trim().toLowerCase() !== name.trim().toLowerCase());
  return client.finding!.criticalRatios!.length < before;
}

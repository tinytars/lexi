import type { Client, FindingDecisionEntry } from "./types";
import { buildLeafContext } from "./leaf-regen-context";

// Every row's `group` must name an existing body system, else system-groups.ts files it under "Not yet categorized".
export function assertDiseaseGroups(client: Client, node: string, rows: { group?: string }[]): void {
  // No early-out on an empty set: a leaf regen only runs against an existing Finding, so empty disease[] is malformed.
  const groups = new Set((client.finding?.disease ?? []).map((d) => d.group));
  for (const row of rows) {
    if (row.group && !groups.has(row.group)) {
      throw new Error(`${node}: group "${row.group}" is not one of the current disease groups`);
    }
  }
}

// The subject a label is ABOUT: everything before the first digit, so "Rosuvastatin 20 mg" matches "Rosuvastatin 20mg/day".
export function labelSubject(label: string): string {
  return label.toLowerCase().replace(/\s*\d.*$/, "").trim() || label.trim().toLowerCase();
}

// Patch-by-key merge: matches are patched in place, new keys appended, unanswered entries kept as-is.
// `subjectOf` lets a re-answer under a drifted label (a re-read dose) supersede the stale entry instead of duplicating it.
export function mergeLabeledItems<TExisting, TReturned>(
  existing: TExisting[],
  returned: TReturned[],
  keyOf: (item: TExisting | TReturned) => string,
  buildNew?: (item: TReturned, existing?: TExisting) => TExisting,
  subjectOf?: (item: TExisting | TReturned) => string,
): TExisting[] {
  const byKey = new Map(returned.map((item) => [keyOf(item), item]));
  const existingKeys = new Set(existing.map((item) => keyOf(item)));
  const returnedSubjects = subjectOf ? new Set(returned.map(subjectOf)) : undefined;
  const merged: TExisting[] = [];
  for (const item of existing) {
    const match = byKey.get(keyOf(item));
    if (match !== undefined) {
      merged.push(buildNew ? buildNew(match, item) : (match as unknown as TExisting));
      continue;
    }
    // Superseded: readers take the first match, so a staler entry about the same subject must go.
    if (returnedSubjects?.has(subjectOf!(item))) continue;
    merged.push(item);
  }
  for (const item of returned) {
    if (!existingKeys.has(keyOf(item))) {
      merged.push(buildNew ? buildNew(item) : (item as unknown as TExisting));
    }
  }
  return merged;
}

// Same bounds as finding-assemble.ts's core-path decision check (2..8 bullets, non-empty prose) so the paths cannot drift.
export function assertDecisionBody(label: string, d: FindingDecisionEntry): void {
  for (const field of ["pros", "cons", "alternatives"] as const) {
    const bullets = d[field];
    if (!Array.isArray(bullets) || bullets.length < 2) throw new Error(`${label} ${field} must be an array of 2+ bullets`);
    if (bullets.length > 8) throw new Error(`${label} ${field} has more than 8 bullets`);
    for (const [j, b] of bullets.entries()) {
      if (typeof b !== "string" || b.trim().length === 0) throw new Error(`${label} ${field}[${j}] is empty`);
    }
  }
  if (typeof d.recommendation !== "string" || d.recommendation.trim().length === 0) {
    throw new Error(`${label} recommendation is empty`);
  }
  if (typeof d.purpose !== "string" || d.purpose.trim().length === 0) throw new Error(`${label} purpose is empty`);
}

export interface IdRowResult {
  result: string;
  group: string;
  [idField: string]: string;
}

export function validateIdRows(idField: string) {
  return (raw: unknown): { items: IdRowResult[] } => {
    const items = (raw as { items?: unknown })?.items;
    if (!Array.isArray(items)) throw new Error("items missing or not an array");
    for (const entry of items) {
      const e = entry as Record<string, unknown>;
      if (typeof e?.[idField] !== "string" || typeof e?.result !== "string" || typeof e?.group !== "string") {
        throw new Error(`item does not match { ${idField}, result, group } shape`);
      }
      // An empty string would render as a blank AI paragraph that reads as "nothing to say".
      if ((e[idField] as string).trim() === "" || (e.result as string).trim() === "" || (e.group as string).trim() === "") {
        throw new Error(`item has an empty ${idField}, result or group`);
      }
    }
    return { items: items as IdRowResult[] };
  };
}

// Narrowing BEFORE the request means the context's id list is exactly what the model was asked about, scoped or not.
export function filterRowsById(node: string, contextKey: string) {
  return (client: Client, targetIds?: string[]): Record<string, unknown> => {
    const context = buildLeafContext(node, client);
    if (!targetIds?.length) return context;
    const ids = new Set(targetIds);
    return { ...context, [contextKey]: (context[contextKey] as { id: string }[]).filter((r) => ids.has(r.id)) };
  };
}

// Membership, duplicates and coverage by labelSubject; a SCOPE OVERRIDE (`targetLabels`) narrows the expected set.
export function assertLabelSetMatches(
  node: string,
  rowNoun: string,
  expectedLabels: string[],
  answeredLabels: string[],
  targetLabels?: string[],
): void {
  const key = (s: string) => labelSubject(s.trim());
  let expected = new Map(expectedLabels.map((l) => [key(l), l]));
  if (targetLabels?.length) {
    const scoped = new Set(targetLabels.map(key));
    expected = new Map([...expected].filter(([k]) => scoped.has(k)));
  }
  const seen = new Set<string>();
  for (const raw of answeredLabels) {
    const k = key(raw);
    if (!expected.has(k)) {
      throw new Error(`${node}: "${raw.trim()}" is not one of the ${expected.size} ${rowNoun} this request asked about`);
    }
    if (seen.has(k)) throw new Error(`${node}: "${raw.trim()}" appears more than once`);
    seen.add(k);
  }
  const missing = [...expected].filter(([k]) => !seen.has(k)).map(([, l]) => l);
  if (missing.length > 0) {
    throw new Error(`${node}: ${missing.length} of ${expected.size} ${rowNoun} went unanswered (${missing.join(", ")})`);
  }
}

export function assertIdSetMatches(
  node: string,
  context: Record<string, unknown>,
  contextKey: string,
  idField: string,
  items: IdRowResult[],
): void {
  const expected = new Set((context[contextKey] as { id: string }[]).map((r) => r.id));
  const seen = new Set<string>();
  for (const item of items) {
    const id = item[idField];
    if (!expected.has(id)) {
      throw new Error(`${node}: ${idField} "${id}" is not one of the ${expected.size} rows this request asked about`);
    }
    if (seen.has(id)) throw new Error(`${node}: ${idField} "${id}" was answered twice`);
    seen.add(id);
  }
  if (seen.size !== expected.size) {
    const missing = [...expected].filter((id) => !seen.has(id));
    throw new Error(`${node}: ${missing.length} of ${expected.size} rows went unanswered (${idField} ${missing.join(", ")})`);
  }
}

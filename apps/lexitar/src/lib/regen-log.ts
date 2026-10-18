// W72 (09 item 1) — the regen event log: what a leaf said before, what it says now, and which brain
// changed its mind.
//
// Every leaf regen discards a previous answer. Today that answer is overwritten and gone, so nothing
// in this system can say whether the reasoning is getting better, and no amount of later work can
// reconstruct a year of decisions that were never written down. This is the append that fixes that,
// built before the analysis that will use it, because the data has to exist first.
//
// APPEND-ONLY, and the decision is taken here rather than left to each caller. `appendRegenEvent`
// copies the existing array and adds to the end; it has no update and no delete, and nothing else in
// the codebase writes `regenLog`. A log that can be edited in place is not evidence of anything — it
// is the same mistake `finding.nodeHashes` avoids by being a map rather than a single value.
//
// TWO THINGS DELIBERATELY NOT DONE HERE:
//   - No retention cap. Trimming the oldest entries would quietly delete the long baseline that makes
//     the log worth keeping, and it would do so silently, at exactly the point it started paying off.
//     If size becomes the binding constraint the answer is to move the log out of the vault — a
//     migration, which is recoverable, rather than a truncation, which is not.
//   - No "why". 09 is explicit that "the AI was wrong" and "new source data arrived" are
//     indistinguishable from here, so `triggeredBy` records the OPERATION (a Translate, a whole
//     refresh) and claims nothing about the cause. Recording a guess would poison the dataset in the
//     one way that cannot be detected later.

import type { Client, ClientFinding, RegenEvent } from "./types";
import { BRAIN_VERSIONS } from "./brain-versions";

/**
 * The Finding sections a merge actually rewrote, by reference comparison.
 *
 * Every `mergeInto` is immutable — it spreads a new object for what it touches and carries the rest
 * through unchanged — so `!==` is not an approximation of "changed", it is exact, and it costs one
 * pass over ~30 keys instead of a deep diff of the whole Finding. It also needs no per-node
 * annotation: a leaf that starts writing a new section is logged correctly the day it does, with no
 * registry entry to keep in sync. (`ownedSections` is deliberately not used for this — it is
 * optional, and the one node that omits it rewrites a nested field rather than a whole section.)
 */
export function changedFindingKeys(before: ClientFinding | undefined, after: ClientFinding | undefined): string[] {
  if (!after) return [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  // Provenance, not content: these are stamped by every merge, so including them would report a
  // change on every event and drown the section that actually moved.
  for (const meta of ["basis", "nodeHashes", "promptVersions", "generatedAt", "inputsHash", "generatedBy"]) {
    keys.delete(meta);
  }
  const b = (before ?? {}) as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  return [...keys].filter((k) => b[k] !== a[k]).sort();
}

function slice(finding: ClientFinding | undefined, keys: string[]): Record<string, unknown> {
  const src = (finding ?? {}) as unknown as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, src[k]]));
}

/**
 * Appends one event describing `before → after` for `node`. Returns a new Client; never mutates.
 *
 * Returns the client UNCHANGED when the merge rewrote nothing — an empty event is noise that makes
 * the log expensive without making it informative.
 */
export function appendRegenEvent(
  before: Client,
  after: Client,
  node: string,
  triggeredBy: RegenEvent["triggeredBy"],
  at: string = new Date().toISOString(),
): Client {
  const keys = changedFindingKeys(before.finding, after.finding);
  if (keys.length === 0) return after;
  const event: RegenEvent = {
    at,
    node,
    triggeredBy,
    sections: keys,
    before: slice(before.finding, keys),
    after: slice(after.finding, keys),
  };
  // Absent rather than empty when unknown — same rule as promptVersions. A stamp that defaults is a
  // wrong answer wearing a right answer's shape.
  if (BRAIN_VERSIONS[node]) event.brainVersion = BRAIN_VERSIONS[node];
  return { ...after, regenLog: [...(after.regenLog ?? []), event] };
}

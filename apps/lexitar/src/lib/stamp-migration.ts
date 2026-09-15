// W61/W62, then W71 — the one-time re-stamps for canonicalizer changes.
//
// 39e65bf fixed a real under-invalidation bug: `statedObjective` (goal/focus) was a DAG source that
// nothing consumed, so editing a patient's goal never marked any Finding node stale. The fix added
// it as an input of `markerLevels`, which transitively feeds nearly everything.
//
// Its stated consequence — "every existing client's Finding will now show as stale" — is understated
// in a way that matters. Staleness is a GATE, not a badge (docs/TRANSLATE.md): regenNode refuses a
// leaf Translate while a COMPUTED direct ancestor is stale, and `markerLevels` is a direct ancestor
// of noteResults/allergyResults/familyResults/diseaseResults/treatmentAssessment. So a permanently
// stale markerLevels doesn't just show a chip — it blocks every leaf Translate, and a user turn
// stops getting its reply until someone runs Translate all. That breaks the product rule that a user
// turn ALWAYS gets a reply.
//
// This re-stamps the nodes that the new edge — and only the new edge — moved, so nobody is spuriously
// stale. A node that was ALREADY stale for a real reason is left stale: marking stale prose fresh is
// the one thing this must never do (see LEAF_REGENERABLE's comment in scripts/factors.ts).
import { canonicalFor, canonicalMap, defineDag } from "@pablotech/neuro";
import { FINDING_DAG, findingDag } from "./finding-dag";
import { INPUT_SLICES } from "./node-input-hash";
import type { Client } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// W71 — a SECOND generation, so this is now a chain rather than a pair.
//
// The five inputs added to `markerLevels` (see finding-dag.ts) move the canonical string of nearly
// every node, for exactly the same reason and with exactly the same consequence as W62's one edge.
// What is new is that a Finding can now be TWO generations behind: one stamped before W62 that has
// not been opened since is stale under both rules, and comparing it against a single "legacy" map
// would leave it permanently stale — the very outcome this file exists to prevent.
//
// So each generation is a (dag, slices) pair, oldest first, and a node is re-stamped when its stored
// hash matches ANY of them. Adding the next one means adding a row, not rewriting the comparison.
//
// Two mechanisms reproduce an older string, and which one applies depends on the change:
//
//   - A NEW SOURCE node (statedObjective in W62; pinnedQueries / recommendedMarkers /
//     personalizedRanges here): drop its SLICE. canonicalFor resolves `slices[k]?.()` to undefined
//     and stableStringify drops the key, giving the pre-edge string byte-for-byte without keeping a
//     copy of the old DAG.
//   - A NEW EDGE on an EXISTING source (watchlist, diagnosedDisease): dropping the slice is not
//     available — other nodes legitimately consume it, and dropping it would move their strings too.
//     That needs a DAG with the edge removed.
// ─────────────────────────────────────────────────────────────────────────────

/** The five inputs W71 added to markerLevels. Named once; the legacy DAG is derived by removing them. */
const W71_MARKER_LEVEL_INPUTS = ["watchlist", "diagnosedDisease", "pinnedQueries", "recommendedMarkers", "personalizedRanges"];

const DAG_BEFORE_W71 = defineDag(
  FINDING_DAG.map((n) =>
    n.key === "markerLevels" ? { ...n, inputs: n.inputs.filter((i) => !W71_MARKER_LEVEL_INPUTS.includes(i)) } : n,
  ),
);

const { statedObjective: _addedInW62, pinnedQueries: _p, recommendedMarkers: _r, personalizedRanges: _pr, ...SLICES_BEFORE_W62 } = INPUT_SLICES;
const { pinnedQueries: _p2, recommendedMarkers: _r2, personalizedRanges: _pr2, ...SLICES_BEFORE_W71 } = INPUT_SLICES;

interface Generation {
  dag: typeof findingDag;
  slices: typeof INPUT_SLICES;
}

/** Oldest first. The current rule is NOT a member — it is the thing being migrated TO. */
const PRIOR_GENERATIONS: Generation[] = [
  { dag: DAG_BEFORE_W71, slices: SLICES_BEFORE_W62 }, // before W62's statedObjective edge
  { dag: DAG_BEFORE_W71, slices: SLICES_BEFORE_W71 }, // after W62, before W71's five
];

const SOURCE_KEYS = new Set(FINDING_DAG.filter((n) => n.kind === "source").map((n) => n.key));

/** Retained for the CLI/tests: one node's canonical string under the oldest rule. */
export function legacyNodeInputCanonical(client: Client, nodeKey: string): string {
  return canonicalFor(PRIOR_GENERATIONS[0].dag, client, PRIOR_GENERATIONS[0].slices, nodeKey);
}

/**
 * Canonical strings per stamped node: one map per prior generation, plus the current one.
 *
 * Callers hash them with their own hasher — node:crypto in the CLI, SubtleCrypto in the browser — so
 * this file stays sync and pure.
 */
export function canonicalGenerations(client: Client): { legacy: Record<string, string>[]; current: Record<string, string> } {
  return {
    legacy: PRIOR_GENERATIONS.map((g) => canonicalMap(g.dag, client, g.slices)),
    current: canonicalMap(findingDag, client, INPUT_SLICES),
  };
}

/**
 * Which stamped hashes to replace, given the Finding's stamp and the hashed maps.
 *
 * A node is re-stamped ONLY when its stored hash equals what it hashed to under SOME earlier rule —
 * proving it was fresh then, and that a canonicalizer change is the only thing that moved it. A node
 * that was ALREADY stale for a real reason matches no generation and is left stale: marking stale
 * prose fresh is the one thing this must never do (see LEAF_REGENERABLE in scripts/factors.ts).
 */
export function restampKeys(
  stamped: Record<string, string>,
  legacyHashes: Record<string, string>[],
  currentHashes: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(currentHashes)) {
    if (stamped[key] === currentHashes[key]) continue;                        // already current
    if (stamped[key] === undefined) {
      // A node that did not EXIST when this Finding was stamped. W71 added three (pinnedQueries,
      // recommendedMarkers, personalizedRanges), and driftedKeys treats a missing entry as drifted —
      // so without this they would read stale on every Finding ever generated, permanently, and
      // isFindingStale would never again return false.
      //
      // Restricted to SOURCE nodes on purpose. A source's stamp is a hash of raw input and carries no
      // generated prose, so adopting the current value blesses nothing. A newly added DERIVED or LEAF
      // node has prose that genuinely has never been generated, and calling that fresh is the one
      // thing this file must never do.
      if (SOURCE_KEYS.has(key)) out[key] = currentHashes[key];
      continue;
    }
    if (!legacyHashes.some((gen) => stamped[key] === gen[key])) continue;     // stale for a real reason
    out[key] = currentHashes[key];
  }
  return out;
}

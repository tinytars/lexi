import type { Client } from "./types";
import { driftedKeys, isStamped } from "@pablotech/neuro-pil";
import { sha256hex12 } from "@pablotech/neuro-pil/hash-web";
import { findingInputsCanonicalString } from "./factors-hash";
import { nodeInputCanonical } from "./node-input-hash";
import { canonicalGenerations, restampKeys } from "./stamp-migration";
import { findingDag } from "./finding-dag";

export function findingInputsHash(client: Client): Promise<string> {
  return sha256hex12(findingInputsCanonicalString(client));
}

// The stamp for a single node's current inputs — used to re-freshen a node's nodeHashes entry after
// an in-app leaf refresh (W15c regroup) so its stale chip clears. Same canonicalizer as the CLI.
export function nodeHashNow(client: Client, nodeKey: string): Promise<string> {
  return sha256hex12(nodeInputCanonical(client, nodeKey));
}

// W15/3b.2 — the full per-node stamp for a freshly-generated Finding, the browser twin of the CLI's
// nodeHashesOf (scripts/factors.ts): every non-projection DAG node, same canonicalizer + hash, so a
// web-refreshed Finding stamps byte-identically to a CLI one and its stale chips read correctly.
export async function nodeHashes(client: Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const n of findingDag.nodes) {
    if (!isStamped(n)) continue;
    out[n.key] = await sha256hex12(nodeInputCanonical(client, n.key));
  }
  return out;
}

// W15b — the DAG nodes whose inputs have changed since the Finding was generated. Because each node
// is hashed over its transitive raw-input closure (nodeInputCanonical), the transitive dependency
// walk is already baked in: editing patientPlan marks {treatmentGroups, aiOnPlan, finalThoughts}
// stale but leaves the synthetic core fresh. Empty when there's no Finding or it predates nodeHashes
// (pre-W15b) — callers fall back to the monolithic isFindingStale.
export async function staleNodes(client: Client): Promise<Set<string>> {
  const stamped = client.finding?.nodeHashes;
  if (!stamped) return new Set();
  const drifted = new Set(driftedKeys(await nodeHashes(client), stamped));
  if (drifted.size === 0) return drifted;

  // W71 — a node whose stamp matches an OLDER canonicalizer generation has NOT drifted: the rule
  // moved, not the patient's data. Subtracting them here rather than waiting for the persisted
  // re-stamp is what makes the re-stamp an optimisation instead of a correctness requirement.
  //
  // It was the latter for about an hour, and CI caught what that costs. Staleness is a GATE: regen()
  // refuses a leaf Translate while a computed ancestor is stale, so between load and the re-stamp's
  // save round-trip completing, every leaf Translate was gated — a patient could write a note and get
  // silence back. That is the exact failure W62's comment in this file warns about, reintroduced by
  // the machinery meant to prevent it.
  for (const key of Object.keys(await canonicalizerRestamp(client))) drifted.delete(key);
  return drifted;
}

// The CLI stamps the Finding with the hash of the inputs it was generated from
// (finding.inputsHash, plus per-node nodeHashes since W15b). If the current inputs hash differently,
// the Finding is out of date relative to what's now in the vault. No Finding → nothing stale.
export async function isFindingStale(client: Client): Promise<boolean> {
  if (!client.finding) return false;
  if (client.finding.nodeHashes) return (await staleNodes(client)).size > 0;
  return (await findingInputsHash(client)) !== client.finding.inputsHash;
}

/**
 * W62 — the browser half of the statedObjective re-stamp (see stamp-migration.ts for the why).
 *
 * Returns the nodeHashes entries to replace, or {} when there is nothing to do — which is the
 * steady state, so this is a cheap no-op on every load after the first. Lives here because this is
 * the module that owns SubtleCrypto hashing; stamp-migration.ts stays sync and hash-agnostic so the
 * CLI can share its logic.
 */
export async function canonicalizerRestamp(client: Client): Promise<Record<string, string>> {
  const stamped = client.finding?.nodeHashes;
  if (!stamped) return {};
  const { legacy, current } = canonicalGenerations(client);
  const hashAll = async (m: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) out[k] = await sha256hex12(v);
    return out;
  };
  return restampKeys(stamped, await Promise.all(legacy.map(hashAll)), await hashAll(current));
}

// The whole-Finding refresh, as ONE control flow shared by the browser and the CLI.
//
// A LexiTar turn on a leaf used to exist twice: as a LEAF_REGEN_SPECS entry (the Translate button)
// and as a section of the monolith SYSTEM_PROMPT (this refresh). That duplication shipped real bugs
// — the treatment timing rules were corrected in the leaf prompts while the monolith kept its own
// copy saying the current dose is the newest row, so a full refresh would have reintroduced them.
// Here the refresh generates only the CORE sections and then replays the very same leaf specs the
// Translate buttons call, so there is one implementation of each turn.
//
// The leaf runner is injected rather than imported: the browser reaches Anthropic through the
// session-gated /api/leaf-regen relay, the CLI calls runLeafRegen in-process. Injecting it keeps
// the ordering, the failure policy and the save cadence identical in both, which is exactly what
// drifted last time.

import type { Client, ClientFinding } from "./types";
import { FINDING_DAG, dagNode } from "./finding-dag";
import { LEAF_REGEN_SPECS } from "./leaf-regen-registry";
import { assembledFindingViolations } from "./finding-invariants";

export interface LeafFailure {
  node: string;
  label: string;
  message: string;
}

export interface RefreshStage {
  /** 1-based index of the leaf being regenerated, 0 while the core is still streaming. */
  index: number;
  total: number;
  node?: string;
  label?: string;
}

export interface OrchestratedRefresh {
  client: Client;
  failures: LeafFailure[];
  /**
   * Rules the ASSEMBLED Finding breaks — core plus every merged leaf, checked once at the end.
   * Distinct from `failures`, which is per-leaf: a leaf can succeed on its own terms and still leave
   * the whole inconsistent (a stale treatmentGroups beside a fresh AI hypothesis, a result keyed to a
   * note that was deleted mid-run). Empty on a clean run. Never a reason to discard work — everything
   * here is already saved.
   */
  invariants: string[];
}

/**
 * Leaf nodes to regenerate, in dependency order, derived from FINDING_DAG rather than listed by
 * hand — a new spec or a changed edge cannot leave this list stale. Kahn's algorithm over the
 * DAG's own `inputs` edges, filtered to nodes that actually have a leaf-regen spec.
 */
export function leafRegenOrder(): string[] {
  const specced = new Set(Object.keys(LEAF_REGEN_SPECS));
  const remaining = new Map<string, Set<string>>();
  for (const node of FINDING_DAG) {
    if (!specced.has(node.key)) continue;
    // Only edges to OTHER specced leaves constrain us; inputs and core nodes are already in place
    // by the time the leaves run, since the core call has been merged and saved first.
    remaining.set(node.key, new Set(node.inputs.filter((i) => specced.has(i))));
  }
  const order: string[] = [];
  while (remaining.size > 0) {
    // Ties broken by FINDING_DAG order so a run is reproducible, not hash-ordered.
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([k]) => k);
    if (ready.length === 0) throw new Error(`leafRegenOrder: cycle among ${[...remaining.keys()].join(", ")}`);
    for (const key of ready) {
      order.push(key);
      remaining.delete(key);
    }
    for (const deps of remaining.values()) for (const key of ready) deps.delete(key);
  }
  return order;
}

/** Every section written by a leaf's mergeInto, derived from the specs rather than listed by hand. */
export function leafOwnedSections(): (keyof ClientFinding)[] {
  return [...new Set(Object.values(LEAF_REGEN_SPECS).flatMap((s) => s.ownedSections ?? []))];
}

/**
 * W71 — the freshly assembled core, with each leaf-owned section it left empty restored from the
 * Finding being replaced.
 *
 * EMPTY, not merely absent, is the test: `assembleFinding` omits allergyResults/familyResults/
 * diseaseResults entirely but returns `[]` for the other five, and both mean the same thing — the
 * core did not write this section, its leaf will. A non-empty core section is respected (an older
 * stored response can still carry them), and a prior section that was itself empty carries nothing.
 *
 * This is a floor, not a merge: the leaf still overwrites the section outright when it succeeds, so a
 * carried-forward answer only survives a run the leaf lost.
 */
export function carryForwardLeafSections(prior: ClientFinding | undefined, core: ClientFinding): ClientFinding {
  if (!prior) return core;
  const out: ClientFinding = { ...core };
  for (const section of leafOwnedSections()) {
    const fresh = core[section];
    const kept = prior[section];
    if (Array.isArray(fresh) && fresh.length > 0) continue;
    // Indexed write: the sections differ in row type, and the only property they share is that a leaf
    // owns them. `ownedSections` being `keyof ClientFinding` is what makes the KEY safe; the value is
    // copied from the same field of the same type, so there is nothing left for a cast to check.
    if (Array.isArray(kept) && kept.length > 0) (out as unknown as Record<string, unknown>)[section] = kept;
  }
  return out;
}

/**
 * Drops the leaves' nodeHashes entries, so a leaf that never runs reads stale.
 *
 * They were stamped at CORE-assembly time (refresh-client.ts) with the inputs every leaf was about to
 * be given — correct values, stamped thirty seconds too early. A leaf that then failed was recorded
 * as freshly generated from current inputs, so `staleNodes()` reported it fresh: no chip, no sweep,
 * no retry, for a section that had just been emptied. `driftedKeys` treats a missing entry as
 * drifted, which is exactly the reading we want until the leaf earns its stamp back.
 */
function unstampLeaves(finding: ClientFinding, leaves: string[]): ClientFinding {
  const nodeHashes = { ...finding.nodeHashes };
  for (const node of leaves) delete nodeHashes[node];
  return { ...finding, nodeHashes };
}

/**
 * Restores one leaf's stamp after it succeeds.
 *
 * The core-time value is the right one: the patient's raw inputs do not change during a refresh, so
 * hashing again here would produce the same string at the cost of nine more passes over the closure.
 * What was wrong before was never the value — it was stamping all nine unconditionally.
 */
function restampLeaf(client: Client, node: string, coreHashes: Record<string, string>): Client {
  const hash = coreHashes[node];
  if (!hash || !client.finding) return client;
  return { ...client, finding: { ...client.finding, nodeHashes: { ...client.finding.nodeHashes, [node]: hash } } };
}

export interface OrchestrateOptions {
  /** Generates and validates the core sections — the existing streamed monolith call. */
  generateCore: () => Promise<ClientFinding>;
  /**
   * Regenerates one leaf onto the client it is given and returns the merged client. Must go through
   * mergeLeafResult so the leaf's basis is stamped the same way in both callers.
   */
  runLeaf: (client: Client, node: string) => Promise<Client>;
  /** Persists after the core and after each leaf, so a later failure never loses earlier work. */
  save?: (client: Client) => Promise<void>;
  onStage?: (stage: RefreshStage) => void;
  signal?: AbortSignal;
}

/**
 * Core first, then each leaf in dependency order.
 *
 * A leaf that fails is recorded and skipped rather than aborting the run: one rate-limited node
 * should not discard a completed core and six good leaves the way the single-call refresh did, and
 * every leaf remains individually retryable from its own Translate. Cancellation IS honoured
 * between leaves — an abort is the operator's decision, unlike a failure.
 */
export async function orchestrateRefresh(
  client: Client,
  { generateCore, runLeaf, save, onStage, signal }: OrchestrateOptions,
): Promise<OrchestratedRefresh> {
  const order = leafRegenOrder();
  onStage?.({ index: 0, total: order.length });

  const core = await generateCore();
  // The core cannot narrate the leaf-owned sections, so replacing the Finding with it wholesale
  // blanks all nine before a single leaf has run. Carry the prior answers forward and un-stamp the
  // leaves: until each one succeeds, its section reads STALE (last known answer, flagged) rather than
  // EMPTY-and-fresh (silently gone, and indistinguishable from "the AI had nothing to say").
  const coreHashes = core.nodeHashes ?? {};
  const finding = unstampLeaves(carryForwardLeafSections(client.finding, core), order);
  let current: Client = { ...client, finding };
  await save?.(current);

  const failures: LeafFailure[] = [];
  for (const [i, node] of order.entries()) {
    if (signal?.aborted) throw new DOMException("refresh cancelled", "AbortError");
    const label = dagNode(node)?.label ?? node;
    onStage?.({ index: i + 1, total: order.length, node, label });
    try {
      current = restampLeaf(await runLeaf(current, node), node, coreHashes);
      // Saving per leaf, not once at the end: a mid-run abort or crash then keeps everything that
      // already succeeded, and each save is the same shape the Translate button already performs.
      await save?.(current);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      failures.push({ node, label, message: e instanceof Error ? e.message : String(e) });
    }
  }
  // Once, on the finished article — not per leaf. Running it inside runLeaf would have a single
  // Translate report violations caused by eight other nodes and blame its own button.
  return { client: current, failures, invariants: assembledFindingViolations(current) };
}

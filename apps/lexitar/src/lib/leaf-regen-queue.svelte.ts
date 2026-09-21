// The browser's leaf-regen queue: which node may regenerate right now, and never twice at once.
//
// This was ~120 lines inside App.svelte, and it was the most substantial logic in that file that had
// no home of its own — the dedupe registry, the single-flight guard, the staleness gate and the
// live-vault re-read, all interleaved with 80 other pieces of component state. Its CONSUMER half was
// already extracted (leaf-translate.svelte.ts owns each row's busy/error state); this closes the pair.
//
// Same getter-parameterized factory shape as draft-sync.svelte.ts: the host passes thunks rather than
// values, so this module never captures a stale client, and `persist` stays with App because App owns
// the vault and its encryption key. What moves here is the part that is about leaf regeneration
// rather than about being a component.

import type { Client } from "./types";
import { dagNode } from "./finding-dag";
import { nodeInputCanonical } from "./node-input-hash";
import { isFindingStale, staleNodes } from "./staleness";
import { fetchLeafRegen, type PendingLeafRegen } from "./leaf-regen-client";
import { aiErrorCode, describeAiError } from "./ai-error";

/**
 * The nodes the background sweep will regenerate. Deliberately NOT every LEAF_REGEN_SPECS key: a node
 * whose ancestors need the full core regen cannot be fixed from the browser, and sweeping it would
 * bill an Anthropic call per page load for a result that cannot land.
 */
export const LEAF_REGEN_NODES = [
  "treatmentGroups",
  "hypothesisEvaluation",
  "aiOnPlan",
  "treatmentAssessment",
  "studyResults",
  "noteResults",
] as const;

/**
 * The subset with no editor of its own. Every other sweepable node is reachable from a component that
 * calls `trigger` for it after a save (Notes → noteResults, Study → studyResults, …); these two are
 * derived from treatments and the plan, so nothing but the sweep ever asks for them.
 *
 * W75/W76 — the distinction is load-bearing, not taxonomy. The host used to re-sweep ALL of these on
 * every client change, which raced the save's own `trigger` for the same node: one edit, two billed
 * calls with two different input signatures, so the dedupe could not collapse them. Held requests are
 * no longer dropped (that was the W74 silent-drop fix), which is what made the collision visible.
 * After a save the host now sweeps only what nobody else will ask for.
 */
export const UNOWNED_LEAF_NODES = ["treatmentGroups", "aiOnPlan"] as const;

export type RegenStatus = { status: "filled" | "empty" | "skipped" | "failed"; error?: string; errorCode?: string };

export interface LeafRegenQueueDeps {
  /** The client this queue is about, read fresh on every call — never captured. */
  getClient: () => Client | null | undefined;
  getClientId: () => string | null;
  /** The unprompted sweep is provider-gated; a user's own turn is not. See sweep()'s comment. */
  getProviderToken: () => string | null | undefined;
  /**
   * Merge the fetched result onto whatever client is live NOW and persist it. Stays with the host:
   * it owns the vault, the DEK and the R2 id, and none of those are this module's business. Returns
   * false when the context went away mid-flight (provider switched patients), which is a skip, not a
   * failure.
   */
  persist: (pending: PendingLeafRegen, id: string) => Promise<boolean>;
  fetchLeafRegen?: typeof fetchLeafRegen;
}

export interface LeafRegenQueue {
  /** Whether the Finding as a whole reads as stale — drives the refresh chip. */
  readonly stale: boolean;
  refreshStaleFlag(): void;
  /**
   * The unprompted background sweep. Fire-and-forget; ignores results by design. Defaults to every
   * sweepable node — the on-open pass; pass UNOWNED_LEAF_NODES for the after-a-save pass, which must
   * not re-ask for a node the saving component is already triggering itself.
   */
  sweep(nodes?: readonly string[]): void;
  /**
   * One node, on purpose. `force` (the manual Translate menu item) bypasses the staleness gate and the
   * signature dedupe: that gate exists only to stop the passive sweep re-billing a call for a node
   * whose inputs have not changed, and a person pressing Translate is asking for it RIGHT NOW. Gating
   * the click made the button a silent no-op whenever the node already read as fresh.
   */
  trigger(key: string, targetLabels?: string[], force?: boolean): Promise<RegenStatus>;
}

export function createLeafRegenQueue(deps: LeafRegenQueueDeps): LeafRegenQueue {
  let stale = $state(false);

  // Plain objects, not $state: these coordinate in-flight requests and must never drive rendering.
  // Making them reactive would re-run every effect that reads the client on each regen.
  const busy: Partial<Record<string, boolean>> = {};
  const lastSig: Partial<Record<string, string>> = {};
  // At most ONE waiting request per node — see regen()'s single-flight comment. Last one wins: an
  // edit that arrives while another is already waiting supersedes it, because they would both
  // regenerate from the same (newest) client anyway. `background` is carried along so a later
  // background sweep tick can tell whether it would be evicting a real request (never allowed) or
  // just another background retry / nothing at all (fine to take the slot).
  const waiting: Partial<Record<string, { targetLabels?: string[]; force: boolean; background: boolean; settle: (s: RegenStatus) => void }>> = {};

  async function regen(
    key: string,
    c: Client,
    id: string,
    staleSet: Set<string>,
    targetLabels?: string[],
    force = false,
    background = false,
  ): Promise<RegenStatus> {
    const node = dagNode(key);
    if (!node) return { status: "skipped" };
    // A leaf regens off whatever its ancestors currently hold, not off a freshly-regenerated core —
    // `staleSet.has(key)` already means "this node's OWN inputs, as currently stored, changed since
    // it last ran," which is the right question. This used to also block whenever a derived ancestor
    // (markerLevels, aiFindings, ...) was independently stale, on the theory that regenerating against
    // it first would be wasted work once that ancestor refreshed. In practice a core refresh is a
    // deliberate, costly, on-demand action that can go undone indefinitely — so that gate meant a
    // dose edit's own cascade could sit silently unanswered for weeks with no error and no signal,
    // waiting on a core regen nobody had reason to know to run. Existing findings, even if the core as
    // a whole is due for a refresh, are the record LexiTar reasons over; only THIS node's own inputs
    // decide whether it re-runs.
    if (!force && !staleSet.has(key)) {
      return { status: "skipped" };
    }
    const sig = id + "|" + nodeInputCanonical(c, key);
    // Single-flight per node, but NOT a drop. Every treatment shares the `treatmentAssessment` key,
    // and two notes saved back to back share `noteResults`, so a second request landing mid-flight is
    // ordinary. This used to return `skipped` and nothing ever retried it: the second edit got no
    // reply at all, which is the silent "nothing happened" the W74 re-read loop below was written to
    // stop — one screen up from where it was left. Hold the request instead and run it when the
    // in-flight call settles, against the client as it is THEN.
    if (busy[key]) {
      // A background sweep's own direct call is discarded by its caller (`sweep()` calls this with
      // `void`), but a REPLAY of it via runWaiting() is not — it's a real fetch whose result gets
      // persisted, and it's the only thing that can answer a request whose own targeted response the
      // server rejected (e.g. a scope mismatch). So a background call is allowed to take an EMPTY
      // waiting slot, or one already held by another background retry — that's a legitimate, useful
      // retry. What it must never do is evict a REAL, addressed request that's already waiting: that's
      // exactly what silently ate a Fish Oil dose edit — the edit's own targeted request queued behind
      // a busy in-flight call, and a background sweep tick landing moments later evicted it before it
      // ever ran, leaving only the sweep's generic retry to fire once the lock freed.
      const current = waiting[key];
      if (background && current && !current.background) {
        return { status: "skipped" };
      }
      current?.settle({ status: "skipped" });
      return new Promise<RegenStatus>((settle) => {
        waiting[key] = { targetLabels, force, background, settle };
      });
    }
    if (!force && sig === lastSig[key]) return { status: "skipped" };
    lastSig[key] = sig;
    busy[key] = true;
    try {
      const pending = await (deps.fetchLeafRegen ?? fetchLeafRegen)(c, key, targetLabels, id);
      if (!pending) return { status: "empty" };
      const persisted = await deps.persist(pending, id);
      return { status: persisted ? "filled" : "skipped" };
    } catch (e) {
      lastSig[key] = ""; // let the next edit retry; the existing value stays visible meanwhile
      // describeAiError, not e.message: the relay's machine-readable errorCode is what decides the
      // wording, so credit exhaustion reads the same sentence here as everywhere else in the app
      // instead of surfacing the raw JSON body the way this used to.
      return { status: "failed", error: describeAiError(e), errorCode: aiErrorCode(e) };
    } finally {
      busy[key] = false;
      runWaiting(key);
    }
  }

  /** Re-runs the request that arrived mid-flight, re-reading the client rather than reusing the old one. */
  function runWaiting(key: string): void {
    const next = waiting[key];
    if (!next) return;
    delete waiting[key];
    void triggerNode(key, next.targetLabels, next.force).then(next.settle, (e) =>
      next.settle({ status: "failed", error: describeAiError(e), errorCode: aiErrorCode(e) }),
    );
  }

  async function triggerNode(key: string, targetLabels?: string[], force = false): Promise<RegenStatus> {
    const c = deps.getClient();
    const id = deps.getClientId();
    // NO provider gate — deliberately. This is the after-a-save twin: a user added or edited a turn
    // and is owed LexiTar's reply to it. Gating it meant a patient could write a note and get
    // silence back, which is not what "regens are a provider action" was ever about ("regen" =
    // Translate all; this is one turn's Translate).
    if (!c?.finding || !id) return { status: "skipped" };

    // W74 — RE-READ rather than give up when the client moves under us.
    //
    // `staleNodes` hashes the node's whole input closure, so it is slow enough that a second save can
    // land while it runs. This used to return `skipped` in that case, which is correct about the
    // snapshot being stale and wrong about what to do: the user made TWO edits and got a translation
    // for neither — the first was abandoned as stale, and nothing re-triggered it. Silent, and
    // exactly the kind of "nothing happened" this queue exists to prevent.
    //
    // Recomputing against the newer client keeps the original intent (never regen from a stale
    // snapshot) while still answering the edit. Bounded, because a client that changes on every pass
    // means edits are arriving faster than we can hash — at which point the last one wins and the
    // earlier ones were superseded anyway, which is the right answer.
    //
    // "Moved" is judged by THIS key's own canonical input, not by object identity — the sweep's
    // background regens of OTHER nodes reassign `client` on every persist (App.svelte's `vault =
    // next`), which used to read as "moved" on every attempt and starve this loop even though
    // nothing this key's own inputs depend on had changed. A provider opening a patient with several
    // genuinely stale nodes (the common case once a real vault, not a pre-translated fixture, is
    // behind this) made that starvation the common case rather than the rare one.
    //
    // Two edits to the SAME key landing close together (e.g. an AM and a PM dose saved back to
    // back) each run this loop concurrently, and each one's "moved" check can trip on the OTHER's
    // edit every time — a real race, not a hypothetical one; it's exactly what silently dropped
    // Fish Oil's dose edits. The bound exists so this converges instead of hashing forever, and the
    // comment above always said "the last one wins" — but the loop used to give up and return
    // skipped on attempt 3 without ever calling regen(), which is the opposite of that. The last
    // attempt now commits: it always calls regen() against whatever the client currently is.
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = deps.getClient();
      if (!snapshot?.finding || deps.getClientId() !== id) {
        return { status: "skipped" };
      }
      const staleSet = force ? new Set<string>() : await staleNodes(snapshot);
      // Re-check id, not just the client reference, immediately after the await: a genuine patient
      // switch is the one kind of "moved" that must always abort, and it is signalled by id — the
      // canonical-input comparison below is deliberately soft (it tolerates an unrelated sweep
      // persist reassigning the client for the SAME patient) and must never be asked to also catch
      // this harder case.
      if (deps.getClientId() !== id) return { status: "skipped" };
      const latest = deps.getClient();
      if (!latest?.finding) return { status: "skipped" };
      if (attempt === 2 || latest === snapshot || nodeInputCanonical(latest, key) === nodeInputCanonical(snapshot, key)) {
        return regen(key, latest, id, staleSet, targetLabels, force);
      }
    }
    return { status: "skipped" };
  }

  return {
    get stale() {
      return stale;
    },

    refreshStaleFlag() {
      const c = deps.getClient();
      if (!c) {
        stale = false;
        return;
      }
      void isFindingStale(c).then((v) => {
        if (deps.getClient() === c) stale = v;
      });
    },

    sweep(nodes: readonly string[] = LEAF_REGEN_NODES) {
      const c = deps.getClient();
      const id = deps.getClientId();
      // W62 — the UNPROMPTED sweep, and the only leaf caller that is provider-gated. It fires a
      // translation for every stale node on load, with no user action behind it: neither a user turn
      // (which always gets its reply, via trigger) nor a deliberate "Translate all". A patient opening
      // their own dashboard should never set that off, so it waits for a provider.
      if (!c?.finding || !id || !deps.getProviderToken()) return;
      void staleNodes(c).then((staleSet) => {
        if (deps.getClient() !== c) return;
        // Deliberately parallel, unlike the range sweep (range-fill.ts), which awaits its first call
        // so the rest read one warm corpus cache entry. That saving cannot exist here: a prompt cache
        // prefix renders tools -> system -> messages, and each node sends its OWN tool schema and its
        // own system prompt ahead of the corpus (leaf-regen-anthropic.ts), so every node's corpus is
        // already a separate entry however these are ordered. Serializing would buy wall-clock time
        // for nothing. See CORPUS.md's caching section.
        for (const key of nodes) void regen(key, c, id, staleSet, undefined, false, true);
      });
    },

    trigger(key, targetLabels, force = false) {
      return triggerNode(key, targetLabels, force);
    },
  };
}

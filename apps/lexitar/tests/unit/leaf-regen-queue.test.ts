import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// W68 — the first unit tests for the queue. It was extracted from App.svelte in W67 and shipped on
// e2e alone, and e2e cannot exercise a race: every one of the concurrency behaviours below is
// invisible to a Playwright spec, which sees only the final DOM.

const { fetchLeafRegen, staleNodes, isFindingStale, nodeInputCanonical } = vi.hoisted(() => ({
  fetchLeafRegen: vi.fn(),
  staleNodes: vi.fn(),
  isFindingStale: vi.fn(),
  nodeInputCanonical: vi.fn(),
}));
vi.mock("../../src/lib/leaf-regen-client", () => ({ fetchLeafRegen }));
vi.mock("../../src/lib/staleness", () => ({ staleNodes, isFindingStale }));
vi.mock("../../src/lib/node-input-hash", () => ({ nodeInputCanonical }));

import { createLeafRegenQueue, LEAF_REGEN_NODES, UNOWNED_LEAF_NODES } from "../../src/lib/leaf-regen-queue.svelte";
import type { Client } from "../../src/lib/types";

const client = (tag = "c1") => ({ displayName: tag, finding: { disease: [] } }) as unknown as Client;

/** All six sweepable nodes stale, so a test only has to say what should BLOCK. */
const allStale = () =>
  new Set(["treatmentGroups", "hypothesisEvaluation", "aiOnPlan", "treatmentAssessment", "studyResults", "noteResults"]);

function makeQueue(over: Partial<Parameters<typeof createLeafRegenQueue>[0]> = {}) {
  const persist = vi.fn(async () => true);
  // ONE instance held across calls: the queue compares client identity before and after each await to
  // abandon a result whose patient was switched mid-flight, so a getter returning a fresh object every
  // call would (correctly) skip everything.
  const held = client();
  const q = createLeafRegenQueue({
    getClient: () => held,
    getClientId: () => "alex",
    getProviderToken: () => "tok",
    persist,
    ...over,
  });
  return { q, persist };
}

beforeEach(() => {
  vi.clearAllMocks();
  nodeInputCanonical.mockReturnValue("sig-1");
  staleNodes.mockResolvedValue(allStale());
  isFindingStale.mockResolvedValue(false);
  fetchLeafRegen.mockResolvedValue({ node: "noteResults", validated: {}, targetIds: undefined });
});

describe("single-flight: one node regenerates at a time, and nothing is dropped", () => {
  // W75. This used to assert the opposite — a second request mid-flight returned "skipped" with a
  // "still running" message and nothing ever retried it. Two notes saved back to back meant the
  // second got no reply at all: the silent drop the W74 re-read loop was written to stop, one screen
  // up from where it was left.
  it("holds a request that lands mid-flight and runs it when the first settles", async () => {
    let release!: () => void;
    fetchLeafRegen.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ node: "noteResults", validated: {} }))),
    );
    const { q } = makeQueue();

    const first = q.trigger("noteResults");
    await Promise.resolve();
    await Promise.resolve();

    nodeInputCanonical.mockReturnValue("sig-2"); // the second save changed the node's inputs
    const second = q.trigger("noteResults");
    await Promise.resolve();
    expect(fetchLeafRegen).toHaveBeenCalledTimes(1); // still one at a time

    release();
    expect((await first).status).toBe("filled");
    expect((await second).status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(2);
  });

  it("keeps only the newest waiting request — an edit that supersedes another does not bill twice", async () => {
    let release!: () => void;
    fetchLeafRegen.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ node: "noteResults", validated: {} }))),
    );
    const { q } = makeQueue();

    const first = q.trigger("noteResults");
    await Promise.resolve();
    await Promise.resolve();

    const superseded = q.trigger("noteResults");
    nodeInputCanonical.mockReturnValue("sig-2");
    const newest = q.trigger("noteResults");
    await Promise.resolve();

    release();
    expect((await first).status).toBe("filled");
    expect((await superseded).status).toBe("skipped");
    expect((await newest).status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(2);
  });

  // The live Fish Oil repro: a background sweep tick landing between a real edit's own trigger and
  // that edit's turn at the front of the queue used to evict the edit's waiting slot — its own result
  // is thrown away by sweep() (`void regen(...)`), so nobody noticed the edit it displaced never ran.
  it("a background sweep hitting busy does not displace a real request already waiting", async () => {
    let release!: () => void;
    fetchLeafRegen.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ node: "noteResults", validated: {} }))),
    );
    const { q } = makeQueue();

    const first = q.trigger("treatmentAssessment");
    await Promise.resolve();
    await Promise.resolve();

    nodeInputCanonical.mockReturnValue("sig-2"); // the second edit changed the dose
    const real = q.trigger("treatmentAssessment", ["Fish Oil"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    q.sweep(["treatmentAssessment"]); // background — hits busy, and must not evict `real`
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchLeafRegen).toHaveBeenCalledTimes(1); // still just `first` — the background hit gave up

    release();
    expect((await first).status).toBe("filled");
    expect((await real).status).toBe("filled"); // not "skipped" — the sweep must not have evicted it
    expect(fetchLeafRegen).toHaveBeenCalledTimes(2);
  });

  // The live Study/M66 repro: a scoped save's own request can come back rejected by the server (a
  // targetLabels scope mismatch) with nothing else to answer it, while an untargeted sweep retry that
  // arrived mid-flight and found the waiting slot EMPTY is exactly what's left to persist a result —
  // dropping that retry unconditionally (rather than only when it would evict a real request) silently
  // regressed this case while fixing the Fish Oil one.
  it("a background sweep hitting busy still queues and later runs when nothing real is waiting", async () => {
    let release!: () => void;
    fetchLeafRegen.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ node: "noteResults", validated: {} }))),
    );
    const { q } = makeQueue();

    const first = q.trigger("treatmentAssessment");
    await Promise.resolve();
    await Promise.resolve();

    q.sweep(["treatmentAssessment"]); // background — hits busy, but nothing real is waiting
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchLeafRegen).toHaveBeenCalledTimes(1); // still just `first`, queued not yet run

    nodeInputCanonical.mockReturnValue("sig-2"); // inputs moved on since `first` was dispatched
    release();
    expect((await first).status).toBe("filled");
    await vi.waitFor(() => expect(fetchLeafRegen).toHaveBeenCalledTimes(2)); // the sweep's retry ran
  });

  it("frees the node once the first settles, even when it threw", async () => {
    fetchLeafRegen.mockRejectedValueOnce(new Error("boom"));
    const { q } = makeQueue();

    expect((await q.trigger("noteResults")).status).toBe("failed");
    // Not still "busy" — a thrown request that left the flag set would wedge the node for the session.
    expect((await q.trigger("noteResults")).status).toBe("filled");
  });
});

describe("signature dedupe: the same unchanged inputs are not re-billed", () => {
  it("suppresses a repeat for identical inputs, and fires again once they change", async () => {
    const { q } = makeQueue();

    expect((await q.trigger("noteResults")).status).toBe("filled");
    expect((await q.trigger("noteResults")).status).toBe("skipped");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(1);

    nodeInputCanonical.mockReturnValue("sig-2");
    expect((await q.trigger("noteResults")).status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(2);
  });

  it("force bypasses the dedupe — a person pressing Translate is asking for it now", async () => {
    const { q } = makeQueue();
    await q.trigger("noteResults");
    expect((await q.trigger("noteResults", undefined, true)).status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(2);
  });

  it("a failure clears the signature so the next edit retries instead of being deduped away", async () => {
    fetchLeafRegen.mockRejectedValueOnce(new Error("offline"));
    const { q } = makeQueue();

    expect((await q.trigger("noteResults")).status).toBe("failed");
    // Same inputs. Without the reset this would dedupe to "skipped" and the row would never recover.
    expect((await q.trigger("noteResults")).status).toBe("filled");
  });
});

describe("the staleness gate looks only at the node's own staleness", () => {
  it("does not fire for a node that is not stale", async () => {
    staleNodes.mockResolvedValue(new Set<string>());
    const { q } = makeQueue();
    expect((await q.trigger("noteResults")).status).toBe("skipped");
    expect(fetchLeafRegen).not.toHaveBeenCalled();
  });

  it("a stale SOURCE ancestor does not block — it is stale because of the very edit that triggered this", async () => {
    // pursuedNotes is a source input of noteResults; adding a note dirties it by definition.
    staleNodes.mockResolvedValue(new Set(["noteResults", "pursuedNotes"]));
    const { q } = makeQueue();
    expect((await q.trigger("noteResults")).status).toBe("filled");
  });

  // A stale DERIVED ancestor (markerLevels, aiFindings, ...) used to hold the leaf back until a full
  // core `--refresh-finding` cleared it — a deliberate, costly, on-demand action that can go undone
  // indefinitely. That turned an ordinary edit's own cascade into a silent no-op with no error and no
  // signal that anything was waiting. The leaf now regens off whatever the ancestor currently holds:
  // existing findings, not a demand for new ones.
  it("a stale DERIVED ancestor does not block — the leaf regens off the existing findings, not a fresh core", async () => {
    staleNodes.mockResolvedValue(new Set(["noteResults", "aiFindings"]));
    const { q } = makeQueue();
    expect((await q.trigger("noteResults")).status).toBe("filled");
  });

  it("force fires even when the node itself is not stale — a person pressing Translate is asking for it now", async () => {
    staleNodes.mockResolvedValue(new Set<string>());
    const { q } = makeQueue();
    expect((await q.trigger("noteResults", undefined, true)).status).toBe("filled");
  });
});

describe("a context that goes away mid-flight is a skip, not a failure", () => {
  it("abandons the result when the client is swapped while staleNodes is resolving", async () => {
    let current = client("before");
    let currentId = "alex";
    staleNodes.mockImplementation(async () => {
      current = client("after"); // provider switched patients during the await
      currentId = "blair";
      return allStale();
    });
    const { q } = makeQueue({ getClient: () => current, getClientId: () => currentId });

    expect((await q.trigger("noteResults")).status).toBe("skipped");
    expect(fetchLeafRegen).not.toHaveBeenCalled();
  });

  it("treats persist returning false as a skip — the host lost its vault, the model did nothing wrong", async () => {
    const { q } = makeQueue({ persist: vi.fn(async () => false) });
    expect((await q.trigger("noteResults")).status).toBe("skipped");
  });

  it("reports 'empty' when the node had nothing to regenerate, without persisting", async () => {
    fetchLeafRegen.mockResolvedValue(null);
    const { q, persist } = makeQueue();
    expect((await q.trigger("noteResults")).status).toBe("empty");
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("the moved-client retry loop always eventually commits", () => {
  // Two saves for the SAME key landing close together (an AM dose then a PM dose) each run this
  // loop concurrently, and each one's "did the client move" check can trip on the OTHER's edit every
  // time — this mock recreates that by making every nodeInputCanonical call return a fresh value, so
  // the snapshot-vs-latest comparison never matches. A prior version of triggerNode gave up after 3
  // such attempts and returned "skipped" WITHOUT ever calling regen() at all — the silent drop that
  // let a dose edit's Assessment sit stale forever with zero error. The last attempt must fire
  // regardless of whether the client is still judged to have moved.
  it("fires regen on the final attempt instead of giving up when the client always reads as moved", async () => {
    let n = 0;
    nodeInputCanonical.mockImplementation(() => `sig-${n++}`);
    const { q } = makeQueue();

    const result = await q.trigger("noteResults");

    expect(result.status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(1);
  });
});

describe("who may start an unprompted sweep", () => {
  // All six: each one's own staleness is what decides whether it fires, not whether some OTHER
  // sweepable node is also stale. Asserting WHICH nodes fire, not how many, so this stays readable
  // when the DAG gains an edge.
  it("a provider's load sweeps every stale node", async () => {
    const { q } = makeQueue();
    q.sweep();
    await vi.waitFor(() => expect(fetchLeafRegen).toHaveBeenCalledTimes(6));

    const swept = fetchLeafRegen.mock.calls.map((c) => c[1]).sort();
    expect(swept).toEqual(["aiOnPlan", "hypothesisEvaluation", "noteResults", "studyResults", "treatmentAssessment", "treatmentGroups"]);
  });

  // W76 — the after-a-save sweep is NOT the on-open sweep, and the difference is a billing bug.
  //
  // The host used to run one sweep keyed on the client object, so every save re-asked for all six
  // nodes — including the very node the saving component was triggering itself, against a client that
  // had moved in between. Two different signatures, so the dedupe could not collapse them: one edit,
  // two calls, second answer overwrites the first. Invisible until W75 stopped dropping a request
  // that lands mid-flight, and then it cost an e2e assertion that had been true since M66.
  it("the after-a-save sweep asks only for nodes no editor triggers itself", async () => {
    const { q } = makeQueue();
    q.sweep(UNOWNED_LEAF_NODES);
    await vi.waitFor(() => expect(fetchLeafRegen).toHaveBeenCalledTimes(2));

    expect(fetchLeafRegen.mock.calls.map((c) => c[1]).sort()).toEqual(["aiOnPlan", "treatmentGroups"]);
  });

  it("every node an editor owns is left out of it, and every unowned one is in", () => {
    // The partition is the whole mechanism. A node that appears in both lists is double-billed on
    // every save of it; one that appears in neither never regenerates after an edit at all.
    const owned = LEAF_REGEN_NODES.filter((n) => !(UNOWNED_LEAF_NODES as readonly string[]).includes(n));
    expect(owned).toEqual(["hypothesisEvaluation", "treatmentAssessment", "studyResults", "noteResults"]);
    expect([...UNOWNED_LEAF_NODES].every((n) => (LEAF_REGEN_NODES as readonly string[]).includes(n))).toBe(true);
  });

  // W62 — a patient opening their own dashboard must not set off six billable calls with no action
  // behind them. Their own saved turn still gets its reply, via trigger, which is NOT gated.
  it("a patient's load sweeps nothing, but their own turn still fires", async () => {
    const { q } = makeQueue({ getProviderToken: () => null });
    q.sweep();
    await Promise.resolve();
    expect(fetchLeafRegen).not.toHaveBeenCalled();

    expect((await q.trigger("noteResults")).status).toBe("filled");
  });
});

describe("the stale flag behind the refresh chip", () => {
  it("tracks the client, and clears when there is none", async () => {
    isFindingStale.mockResolvedValue(true);
    const { q } = makeQueue();
    expect(q.stale).toBe(false);

    q.refreshStaleFlag();
    await vi.waitFor(() => expect(q.stale).toBe(true));

    const { q: q2 } = makeQueue({ getClient: () => undefined });
    q2.refreshStaleFlag();
    expect(q2.stale).toBe(false);
  });
});

// The partition above is only worth having if the HOST uses it, and the host is App.svelte — 0%
// covered, and untestable without a component harness this repo has decided against. What is
// checkable is the source: which sweep each effect calls, and what it reads. Both facts are one line
// each and both are exactly what regressed.
describe("App wires the two sweeps to different dependencies", () => {
  const app = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "App.svelte"),
    "utf8",
  );
  const effects = [...app.matchAll(/\$effect\(\(\) => \{([\s\S]*?)\n  \}\);/g)].map((m) => m[1]);

  it("the after-a-save sweep is scoped, and it is the one that follows the client", () => {
    const saveSweep = effects.filter((b) => b.includes("leafRegen.sweep(UNOWNED_LEAF_NODES)"));
    expect(saveSweep).toHaveLength(1);
    expect(saveSweep[0]).toContain("currentClient");
  });

  it("the on-open sweep does NOT follow the client — that is what double-billed every save", () => {
    const openSweep = effects.filter((b) => /leafRegen\.sweep\(\s*\)/.test(b));
    expect(openSweep).toHaveLength(1);
    expect(openSweep[0]).not.toContain("currentClient");
  });
});

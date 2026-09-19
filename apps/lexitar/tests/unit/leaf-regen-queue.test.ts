import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLeafRegenQueue, LEAF_REGEN_NODES, UNOWNED_LEAF_NODES } from "../../src/lib/leaf-regen-queue.svelte";
import { nodeHashes, staleNodes } from "../../src/lib/staleness";
import type { fetchLeafRegen as FetchLeafRegen, PendingLeafRegen } from "../../src/lib/leaf-regen-client";
import type { Client } from "../../src/lib/types";

const patient = (tag = "c1") =>
  ({ displayName: tag, dob: "1980-01-01", gender: "male", watchlist: [], results: [], factors: { noteEntries: [] }, finding: { disease: [] } }) as unknown as Client;

let labValue = 0;
/** A new lab result is in every sweepable node's input closure, so this moves each one's signature. */
const editInputs = (c: Client) => c.results.push({ marker: "Ferritin", date: "2026-01-01", value: ++labValue, unit: "ng/mL" } as Client["results"][number]);

/** Stamps the Finding against the client's current inputs, with `stale` stamped as drifted. */
async function stamp(c: Client, stale: readonly string[] = LEAF_REGEN_NODES): Promise<Client> {
  const hashes = await nodeHashes(c);
  for (const k of stale) hashes[k] = "drifted";
  c.finding!.nodeHashes = hashes;
  return c;
}

const regenerated = (node = "noteResults") => ({ node, validated: {} }) as PendingLeafRegen;

async function makeQueue(over: Partial<Parameters<typeof createLeafRegenQueue>[0]> = {}, stale?: readonly string[]) {
  // ONE instance held across calls: the queue abandons a result whose client identity moved mid-flight.
  const held = await stamp(patient(), stale);
  const getClient = vi.fn(() => held);
  const persist = vi.fn(async () => true);
  const fetchLeafRegen = vi.fn<typeof FetchLeafRegen>(async () => regenerated());
  const q = createLeafRegenQueue({
    getClient,
    getClientId: () => "alex",
    getProviderToken: () => "tok",
    persist,
    fetchLeafRegen,
    ...over,
  });
  // Hashing resolves on the crypto threadpool, so microtask ticks can't tell when a caller has passed
  // the staleness gate; the client reads it makes on the way (3 per trigger, 2 per sweep) can.
  const reads = (n: number) => vi.waitFor(() => expect(getClient).toHaveBeenCalledTimes(n));
  return { q, persist, held, fetchLeafRegen, reads };
}

function gate(fetchLeafRegen: ReturnType<typeof vi.fn<typeof FetchLeafRegen>>) {
  let release!: () => void;
  fetchLeafRegen.mockImplementationOnce(() => new Promise((r) => (release = () => r(regenerated()))));
  return () => release();
}

describe("single-flight: one node regenerates at a time, and nothing is dropped", () => {
  it("holds a request that lands mid-flight and runs it when the first settles", async () => {
    const { q, held, fetchLeafRegen, reads } = await makeQueue();
    const release = gate(fetchLeafRegen);

    const first = q.trigger("noteResults");
    await vi.waitFor(() => expect(fetchLeafRegen).toHaveBeenCalledTimes(1));

    editInputs(held);
    const second = q.trigger("noteResults");
    await reads(6);
    expect(fetchLeafRegen).toHaveBeenCalledTimes(1);

    release();
    expect((await first).status).toBe("filled");
    expect((await second).status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(2);
  });

  it("keeps only the newest waiting request — an edit that supersedes another does not bill twice", async () => {
    const { q, held, fetchLeafRegen, reads } = await makeQueue();
    const release = gate(fetchLeafRegen);

    const first = q.trigger("noteResults");
    await vi.waitFor(() => expect(fetchLeafRegen).toHaveBeenCalledTimes(1));

    const superseded = q.trigger("noteResults");
    await reads(6);
    editInputs(held);
    const newest = q.trigger("noteResults");
    await reads(9);

    release();
    expect((await first).status).toBe("filled");
    expect((await superseded).status).toBe("skipped");
    expect((await newest).status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(2);
  });

  // The sweep discards its own result, so an edit it evicted from the waiting slot would never run.
  it("a background sweep hitting busy does not displace a real request already waiting", async () => {
    const { q, held, fetchLeafRegen, reads } = await makeQueue();
    const release = gate(fetchLeafRegen);

    const first = q.trigger("treatmentAssessment");
    await vi.waitFor(() => expect(fetchLeafRegen).toHaveBeenCalledTimes(1));

    editInputs(held);
    const real = q.trigger("treatmentAssessment", ["Fish Oil"]);
    await reads(6);

    q.sweep(["treatmentAssessment"]);
    await reads(8);
    expect(fetchLeafRegen).toHaveBeenCalledTimes(1);

    release();
    expect((await first).status).toBe("filled");
    expect((await real).status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(2);
  });

  // A scoped save's own request can be rejected server-side, leaving the sweep's retry as the only answer.
  it("a background sweep hitting busy still queues and later runs when nothing real is waiting", async () => {
    const { q, held, fetchLeafRegen, reads } = await makeQueue();
    const release = gate(fetchLeafRegen);

    const first = q.trigger("treatmentAssessment");
    await vi.waitFor(() => expect(fetchLeafRegen).toHaveBeenCalledTimes(1));

    q.sweep(["treatmentAssessment"]);
    await reads(5);
    expect(fetchLeafRegen).toHaveBeenCalledTimes(1);

    editInputs(held);
    release();
    expect((await first).status).toBe("filled");
    await vi.waitFor(() => expect(fetchLeafRegen).toHaveBeenCalledTimes(2));
  });

  it("frees the node once the first settles, even when it threw", async () => {
    const { q, fetchLeafRegen } = await makeQueue();
    fetchLeafRegen.mockRejectedValueOnce(new Error("boom"));

    expect((await q.trigger("noteResults")).status).toBe("failed");
    expect((await q.trigger("noteResults")).status).toBe("filled");
  });
});

describe("signature dedupe: the same unchanged inputs are not re-billed", () => {
  it("suppresses a repeat for identical inputs, and fires again once they change", async () => {
    const { q, held, fetchLeafRegen } = await makeQueue();

    expect((await q.trigger("noteResults")).status).toBe("filled");
    expect((await q.trigger("noteResults")).status).toBe("skipped");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(1);

    editInputs(held);
    expect((await q.trigger("noteResults")).status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(2);
  });

  it("force bypasses the dedupe — a person pressing Translate is asking for it now", async () => {
    const { q, fetchLeafRegen } = await makeQueue();
    await q.trigger("noteResults");
    expect((await q.trigger("noteResults", undefined, true)).status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(2);
  });

  it("a failure clears the signature so the next edit retries instead of being deduped away", async () => {
    const { q, fetchLeafRegen } = await makeQueue();
    fetchLeafRegen.mockRejectedValueOnce(new Error("offline"));

    expect((await q.trigger("noteResults")).status).toBe("failed");
    expect((await q.trigger("noteResults")).status).toBe("filled");
  });
});

describe("the staleness gate looks only at the node's own staleness", () => {
  it("does not fire for a node that is not stale", async () => {
    const { q, fetchLeafRegen } = await makeQueue({}, []);
    expect((await q.trigger("noteResults")).status).toBe("skipped");
    expect(fetchLeafRegen).not.toHaveBeenCalled();
  });

  it("a stale SOURCE ancestor does not block — it is stale because of the very edit that triggered this", async () => {
    const { q, held } = await makeQueue({}, []);
    held.factors!.noteEntries!.push({ text: "Started magnesium" } as NonNullable<NonNullable<Client["factors"]>["noteEntries"]>[number]);
    expect((await staleNodes(held)).has("pursuedNotes")).toBe(true);
    expect((await q.trigger("noteResults")).status).toBe("filled");
  });

  it("a stale DERIVED ancestor does not block — the leaf regens off the existing findings, not a fresh core", async () => {
    const { q } = await makeQueue({}, ["noteResults", "aiFindings"]);
    expect((await q.trigger("noteResults")).status).toBe("filled");
  });

  it("force fires even when the node itself is not stale — a person pressing Translate is asking for it now", async () => {
    const { q } = await makeQueue({}, []);
    expect((await q.trigger("noteResults", undefined, true)).status).toBe("filled");
  });
});

describe("a context that goes away mid-flight is a skip, not a failure", () => {
  it("abandons the result when the client is swapped while staleNodes is resolving", async () => {
    let current = await stamp(patient("before"));
    let currentId = "alex";
    const { q, fetchLeafRegen } = await makeQueue({ getClient: () => current, getClientId: () => currentId });

    const result = q.trigger("noteResults");
    current = await stamp(patient("after"));
    currentId = "blair";

    expect((await result).status).toBe("skipped");
    expect(fetchLeafRegen).not.toHaveBeenCalled();
  });

  it("treats persist returning false as a skip — the host lost its vault, the model did nothing wrong", async () => {
    const { q } = await makeQueue({ persist: vi.fn(async () => false) });
    expect((await q.trigger("noteResults")).status).toBe("skipped");
  });

  it("reports 'empty' when the node had nothing to regenerate, without persisting", async () => {
    const { q, persist, fetchLeafRegen } = await makeQueue();
    fetchLeafRegen.mockResolvedValue(null);
    expect((await q.trigger("noteResults")).status).toBe("empty");
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("the moved-client retry loop always eventually commits", () => {
  // Two same-key saves racing can make every attempt read as moved; giving up there silently dropped a dose edit.
  it("fires regen on the final attempt instead of giving up when the client always reads as moved", async () => {
    const stamped = (await stamp(patient())).finding!.nodeHashes;
    const { q, fetchLeafRegen } = await makeQueue({
      getClient: () => {
        const c = patient();
        c.finding!.nodeHashes = stamped;
        editInputs(c);
        return c;
      },
    });

    const result = await q.trigger("noteResults");

    expect(result.status).toBe("filled");
    expect(fetchLeafRegen).toHaveBeenCalledTimes(1);
  });
});

describe("who may start an unprompted sweep", () => {
  it("a provider's load sweeps every stale node", async () => {
    const { q, fetchLeafRegen } = await makeQueue();
    q.sweep();
    await vi.waitFor(() => expect(fetchLeafRegen).toHaveBeenCalledTimes(6));

    const swept = fetchLeafRegen.mock.calls.map((c) => c[1]).sort();
    expect(swept).toEqual(["aiOnPlan", "hypothesisEvaluation", "noteResults", "studyResults", "treatmentAssessment", "treatmentGroups"]);
  });

  // Re-sweeping an owned node after a save races the editor's own trigger: one edit, two billed calls.
  it("the after-a-save sweep asks only for nodes no editor triggers itself", async () => {
    const { q, fetchLeafRegen } = await makeQueue();
    q.sweep(UNOWNED_LEAF_NODES);
    await vi.waitFor(() => expect(fetchLeafRegen).toHaveBeenCalledTimes(2));

    expect(fetchLeafRegen.mock.calls.map((c) => c[1]).sort()).toEqual(["aiOnPlan", "treatmentGroups"]);
  });

  it("every node an editor owns is left out of it, and every unowned one is in", () => {
    const owned = LEAF_REGEN_NODES.filter((n) => !(UNOWNED_LEAF_NODES as readonly string[]).includes(n));
    expect(owned).toEqual(["hypothesisEvaluation", "treatmentAssessment", "studyResults", "noteResults"]);
    expect([...UNOWNED_LEAF_NODES].every((n) => (LEAF_REGEN_NODES as readonly string[]).includes(n))).toBe(true);
  });

  it("a patient's load sweeps nothing, but their own turn still fires", async () => {
    const { q, fetchLeafRegen } = await makeQueue({ getProviderToken: () => null });
    q.sweep();
    expect((await q.trigger("noteResults")).status).toBe("filled");
    // A negative needs a bound: an ungated sweep's five other regens land well inside it.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchLeafRegen.mock.calls.map((c) => c[1])).toEqual(["noteResults"]);
  });
});

describe("the stale flag behind the refresh chip", () => {
  it("tracks the client, and clears when there is none", async () => {
    const { q } = await makeQueue();
    expect(q.stale).toBe(false);

    q.refreshStaleFlag();
    await vi.waitFor(() => expect(q.stale).toBe(true));

    const { q: q2 } = await makeQueue({ getClient: () => undefined });
    q2.refreshStaleFlag();
    expect(q2.stale).toBe(false);
  });
});

// App.svelte has no component harness, so which sweep each effect calls is checked in its source.
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

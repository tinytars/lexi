import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { canonicalGenerations, restampKeys, legacyNodeInputCanonical } from "../../src/lib/stamp-migration";
import { canonicalizerRestamp, staleNodes } from "../../src/lib/staleness";
import { nodeInputCanonical } from "../../src/lib/node-input-hash";
import type { Client } from "../../src/lib/types";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const hashMap = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, h(v)]));

function client(over: Partial<Client> = {}): Client {
  return {
    displayName: "A", dob: "1980-01-01", gender: "male", watchlist: ["ApoB"],
    results: [{ marker: "ApoB", date: "2026-01-01", value: 90, unit: "mg/dL" }],
    factors: { goal: "live long", focus: "lipids" },
    ...over,
  } as Client;
}

describe("legacy canonical", () => {
  // The whole migration rests on this: before each fix, the added input was in no node's closure.
  it("differs from the current canonical exactly where the new edges reach", () => {
    const c = client();
    expect(legacyNodeInputCanonical(c, "markerLevels")).not.toBe(nodeInputCanonical(c, "markerLevels"));
    // labData is a source; nothing was added to its closure.
    expect(legacyNodeInputCanonical(c, "labData")).toBe(nodeInputCanonical(c, "labData"));
  });

  it("the current canonical carries goal/focus and the oldest legacy one does not", () => {
    const c = client();
    expect(nodeInputCanonical(c, "markerLevels")).toContain("live long");
    expect(legacyNodeInputCanonical(c, "markerLevels")).not.toContain("live long");
  });

  // W71 — the watchlist edge specifically. It is the one that cannot be reproduced by dropping a
  // slice (other nodes consume watchlist legitimately), so it is the one that needs the legacy DAG.
  it("markerLevels now carries the watchlist, and neither prior generation did", () => {
    const c = client({ watchlist: ["Lp(a)"] } as Partial<Client>);
    expect(nodeInputCanonical(c, "markerLevels")).toContain("Lp(a)");
    const { legacy } = canonicalGenerations(c);
    for (const [i, gen] of legacy.entries()) expect(gen.markerLevels, `generation ${i}`).not.toContain("Lp(a)");
  });

  // The empty-guard on the three new slices. A client with none of this data must hash byte-identically
  // to before they existed, so only clients who actually have it are re-stamped at all.
  it("a client with no pins, no recommended markers and no ranges is unmoved by those three slices", () => {
    const bare = client();
    const { legacy } = canonicalGenerations(bare);
    // The newest prior generation differs from current ONLY by the watchlist/diagnosedDisease edges.
    expect(legacy.at(-1)!.markerLevels).not.toContain("pinnedQueries");
    expect(nodeInputCanonical(bare, "markerLevels")).not.toContain("pinnedQueries");
    expect(nodeInputCanonical(bare, "markerLevels")).not.toContain("recommendedMarkers");
    expect(nodeInputCanonical(bare, "markerLevels")).not.toContain("personalizedRanges");
  });

  it("but a client who has starred something does move", () => {
    // A pinned NOTE — diseases are not among the pinnable sections (pinned-queries.ts), which is
    // itself worth pinning down here: a fixture that pins something unpinnable would assert nothing.
    const pinned = client({
      factors: { goal: "live long", focus: "lipids", noteEntries: [{ id: "n1", text: "chest tightness on hills", pinned: true }] },
    } as Partial<Client>);
    const current = nodeInputCanonical(pinned, "markerLevels");
    expect(current).toContain("pinnedQueries");
    expect(current).toContain("chest tightness");
    // And it is the pin that did it, not merely having a note: unpinned, the string is unchanged
    // from a client with no note at all in that slice.
    const unpinned = client({
      factors: { goal: "live long", focus: "lipids", noteEntries: [{ id: "n1", text: "chest tightness on hills" }] },
    } as Partial<Client>);
    expect(nodeInputCanonical(unpinned, "markerLevels")).not.toContain("pinnedQueries");
  });
});

describe("restampKeys", () => {
  it.each([0, 1])("re-stamps a Finding that was fresh under generation %i", (gen) => {
    const c = client();
    const { legacy, current } = canonicalGenerations(c);
    const stamped = hashMap(legacy[gen]);
    const patch = restampKeys(stamped, legacy.map(hashMap), hashMap(current));

    expect(Object.keys(patch).length).toBeGreaterThan(0);
    expect(patch).toHaveProperty("markerLevels");
    // After applying, nothing is stale.
    const migrated = { ...stamped, ...patch };
    const now = hashMap(current);
    for (const k of Object.keys(now)) expect(migrated[k], k).toBe(now[k]);
  });

  // The safety rule. A node stale for a REAL reason must survive the migration still stale.
  it("refuses to re-stamp a node that was already stale", () => {
    const c = client();
    const { legacy, current } = canonicalGenerations(c);
    const stamped = { ...hashMap(legacy[0]), markerLevels: "deadbeefcafe" };
    const patch = restampKeys(stamped, legacy.map(hashMap), hashMap(current));
    expect(patch).not.toHaveProperty("markerLevels");
  });

  it("is a no-op on a Finding already stamped under the current rule", () => {
    const c = client();
    const { legacy, current } = canonicalGenerations(c);
    expect(restampKeys(hashMap(current), legacy.map(hashMap), hashMap(current))).toEqual({});
  });

  it("leaves nodes the edges never reached alone", () => {
    const c = client();
    const { legacy, current } = canonicalGenerations(c);
    const patch = restampKeys(hashMap(legacy[0]), legacy.map(hashMap), hashMap(current));
    expect(patch).not.toHaveProperty("labData");
  });
});

// The in-app self-heal, exercised through the real SubtleCrypto path the browser uses (not the
// node:crypto helper above), so the two hashers agreeing is part of what this asserts.
describe("canonicalizerRestamp (browser path)", () => {
  /** A client stamped the way a Finding from generation `gen` is. */
  async function stampedUnder(gen: number, c: Client = client()): Promise<Client> {
    const { legacy } = canonicalGenerations(c);
    const { sha256hex12 } = await import("@pablotech/neuro-pil/hash-web");
    const stamped: Record<string, string> = {};
    for (const [k, v] of Object.entries(legacy[gen])) stamped[k] = await sha256hex12(v);
    return { ...c, finding: { nodeHashes: stamped } } as Client;
  }

  // Generation 0 is a Finding stamped before W62 that has not been opened since — TWO canonicalizer
  // changes behind. A single-legacy comparison would leave it permanently stale, and because
  // staleness is a GATE rather than a badge, a permanently stale markerLevels blocks every leaf
  // Translate: a user turn stops getting its reply. That is the whole reason this is a chain.
  it.each([0, 1])("a Finding stamped under generation %i reads FRESH immediately, before any save", async (gen) => {
    const before = await stampedUnder(gen);

    // The property that matters, and the one CI caught the absence of. Staleness is a gate: regen()
    // refuses a leaf Translate while a computed ancestor is stale. If a legacy-stamped Finding read
    // stale until the re-stamp's save round-trip landed, then for that whole window a patient could
    // write a note and get silence back — the exact failure W62 set out to prevent. So the rule
    // change must be invisible to staleness from the first read, with no persistence involved.
    expect([...(await staleNodes(before))]).toEqual([]);

    // The persisted patch still exists — it is an optimisation (stop recomputing this every load),
    // not the thing correctness rests on.
    const patch = await canonicalizerRestamp(before);
    expect(Object.keys(patch).length).toBeGreaterThan(0);

    const after = { ...before, finding: { ...before.finding!, nodeHashes: { ...before.finding!.nodeHashes!, ...patch } } } as Client;
    expect([...(await staleNodes(after))]).toEqual([]);
  });

  // Genuine drift must still be reported, or the subtraction above would be a way of never being
  // stale again.
  it("still reports a node that is stale for a real reason", async () => {
    const before = await stampedUnder(1);
    const tampered = {
      ...before,
      finding: { ...before.finding!, nodeHashes: { ...before.finding!.nodeHashes!, markerLevels: "deadbeefcafe" } },
    } as Client;
    expect([...(await staleNodes(tampered))]).toContain("markerLevels");
  });

  // Self-terminating: the effect re-runs after its own save, and must not loop.
  it("is a no-op the second time", async () => {
    const before = await stampedUnder(0);
    const patch = await canonicalizerRestamp(before);
    const after = { ...before, finding: { ...before.finding!, nodeHashes: { ...before.finding!.nodeHashes!, ...patch } } } as Client;
    expect(await canonicalizerRestamp(after)).toEqual({});
  });

  it("does nothing for a Finding with no stamp at all", async () => {
    expect(await canonicalizerRestamp(client())).toEqual({});
  });

  it("heals a client who HAS the new data, not just an empty one", async () => {
    const rich = client({
      recommended: ["Lp(a)"],
      personalizedRanges: { ApoB: { low: 40, high: 80, unit: "mg/dL", explanation: "lower is better for ASCVD risk", generatedAt: "2026-01-01T00:00:00Z", factorsHash: "abc123" } },
    });
    const before = await stampedUnder(1, rich);
    expect([...(await staleNodes(before))]).toEqual([]);
    const patch = await canonicalizerRestamp(before);
    const after = { ...before, finding: { ...before.finding!, nodeHashes: { ...before.finding!.nodeHashes!, ...patch } } } as Client;
    expect([...(await staleNodes(after))]).toEqual([]);
  });
});

// A prior version of leaf-regen-queue.ts's regen() blocked a leaf whenever any DERIVED ancestor
// (not just the leaf's own inputs) read as stale — which meant a canonicalizer version bump could
// gate a user's own turn behind ancestors it had nothing to do with. That gate itself is gone now
// (see leaf-regen-queue.svelte.ts's regen() comment: a leaf regens off whatever its ancestors
// currently hold, checking only its OWN staleness), so the class of bug this described — an ancestor
// stale only because the canonicalizer changed, blocking a leaf that never asked about it — is no
// longer reachable through that mechanism at all, for any reason. Nothing left here to assert.

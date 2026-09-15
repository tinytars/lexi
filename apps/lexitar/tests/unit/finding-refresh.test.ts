import { describe, it, expect, vi } from "vitest";
import { leafRegenOrder, orchestrateRefresh } from "../../src/lib/finding-refresh";
import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";
import { dagNode } from "../../src/lib/finding-dag";
import type { Client, ClientFinding } from "../../src/lib/types";

const client = () => ({ displayName: "Alex", results: [] } as unknown as Client);
const finding = () => ({ disease: [] } as unknown as ClientFinding);

describe("leafRegenOrder", () => {
  it("covers exactly the nodes that have a leaf-regen spec", () => {
    expect([...leafRegenOrder()].sort()).toEqual(Object.keys(LEAF_REGEN_SPECS).sort());
  });

  it("places every leaf after the specced leaves it depends on", () => {
    const order = leafRegenOrder();
    for (const [i, node] of order.entries()) {
      for (const input of dagNode(node)?.inputs ?? []) {
        if (!(input in LEAF_REGEN_SPECS)) continue;
        expect(order.indexOf(input), `${input} must precede ${node}`).toBeLessThan(i);
      }
    }
  });

  // aiOnPlan takes hypothesisEvaluation as an input — the one real ordering constraint among the
  // leaves, and the reason this is derived from the DAG rather than hand-listed.
  it("orders aiOnPlan after hypothesisEvaluation", () => {
    const order = leafRegenOrder();
    expect(order.indexOf("aiOnPlan")).toBeGreaterThan(order.indexOf("hypothesisEvaluation"));
  });
});

describe("orchestrateRefresh", () => {
  it("generates the core first, then every leaf in order, saving after each", async () => {
    const seen: string[] = [];
    const saves: number[] = [];
    const res = await orchestrateRefresh(client(), {
      generateCore: async () => { seen.push("core"); return finding(); },
      runLeaf: async (c, node) => { seen.push(node); return c; },
      save: async () => { saves.push(seen.length); },
    });
    expect(seen[0]).toBe("core");
    expect(seen.slice(1)).toEqual(leafRegenOrder());
    expect(res.failures).toEqual([]);
    // One save for the core plus one per leaf — a crash mid-run keeps what already succeeded.
    expect(saves).toHaveLength(leafRegenOrder().length + 1);
  });

  it("keeps going when a leaf fails, reports it, and preserves the earlier merges", async () => {
    const order = leafRegenOrder();
    const victim = order[1];
    const merged: string[] = [];
    const res = await orchestrateRefresh(client(), {
      generateCore: async () => finding(),
      runLeaf: async (c, node) => {
        if (node === victim) throw new Error("rate limited");
        merged.push(node);
        return { ...c, [node]: true } as unknown as Client;
      },
    });
    expect(res.failures).toEqual([
      { node: victim, label: dagNode(victim)?.label ?? victim, message: "rate limited" },
    ]);
    expect(merged).toEqual(order.filter((n) => n !== victim));
    // The successful leaves are still on the returned client — a single failure is not a rollback.
    expect((res.client as unknown as Record<string, boolean>)[order[0]]).toBe(true);
  });

  it("an abort stops the run, unlike a failure", async () => {
    const ctrl = new AbortController();
    const runLeaf = vi.fn(async (c: Client) => { ctrl.abort(); return c; });
    await expect(orchestrateRefresh(client(), {
      generateCore: async () => finding(),
      runLeaf,
      signal: ctrl.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(runLeaf).toHaveBeenCalledTimes(1);
  });

  it("reports stage progress for the core and each leaf", async () => {
    const stages: string[] = [];
    await orchestrateRefresh(client(), {
      generateCore: async () => finding(),
      runLeaf: async (c) => c,
      onStage: (s) => stages.push(`${s.index}/${s.total}${s.node ? ` ${s.node}` : ""}`),
    });
    const total = leafRegenOrder().length;
    expect(stages[0]).toBe(`0/${total}`);
    expect(stages).toHaveLength(total + 1);
    expect(stages[total]).toContain(leafRegenOrder()[total - 1]);
  });
});

// W71 — a full refresh used to blank all nine leaf-owned sections and stamp them fresh.
//
// `assembleFinding` cannot produce them: allergyResults/familyResults/diseaseResults are not fields
// of FindingAIResponse at all, and W65 stopped the core narrating the other six, so they come back
// `?? []`. orchestrateRefresh replaced client.finding with that object and SAVED it before the first
// leaf ran. A leaf that then failed left its section empty forever — and because nodeHashes were
// stamped at core-assembly time, staleNodes() reported the missing section as freshly generated. No
// chip, no sweep, no retry, and nothing to distinguish it from "the AI had nothing to say".
//
// These assert the OUTCOME (what a reader of the vault would find), not the mechanism.

import { carryForwardLeafSections, leafOwnedSections } from "../../src/lib/finding-refresh";
import { driftedKeys } from "@pablotech/neuro";

/** A core response as assembleFinding really returns one: the leaf sections empty or absent. */
const coreOnly = (nodeHashes: Record<string, string> = {}) =>
  ({
    disease: [],
    studyResults: [],
    noteResults: [],
    treatment: [],
    treatmentGroups: [],
    planAssessmentRows: [],
    // allergyResults / familyResults / diseaseResults deliberately ABSENT, as in the real return.
    nodeHashes,
  }) as unknown as ClientFinding;

const priorFinding = () =>
  ({
    disease: [],
    studyResults: [{ study: "s", result: "prior study read", group: "g" }],
    noteResults: [{ noteId: "n1", result: "prior note read", group: "g" }],
    allergyResults: [{ allergyId: "a1", result: "prior allergy read", group: "g" }],
    familyResults: [{ familyId: "f1", result: "prior family read", group: "g" }],
    diseaseResults: [{ diseaseId: "d1", result: "prior diagnosis read", group: "g" }],
    treatment: [{ item: "Metformin", assessment: "prior", group: "g" }],
    treatmentGroups: [{ system: "s", topic: "t", patient: [], ai: [] }],
    planAssessmentRows: [{ action: "walk", assessment: "prior" }],
    nodeHashes: {},
  }) as unknown as ClientFinding;

describe("a failed leaf degrades to stale, never to empty", () => {
  const leafSections = leafOwnedSections();

  it("names every section a leaf writes, and no section the core narrates", () => {
    // Derived from the specs' ownedSections, not listed here — the point is that a NEW leaf cannot
    // be added without joining the carry-forward. Cross-checked against the shape of the core's own
    // output: a section the core fills would be wrong to carry forward.
    expect([...leafSections].sort()).toEqual([
      "allergyResults",
      "diseaseResults",
      "familyResults",
      "noteResults",
      "planAssessmentRows",
      "studyResults",
      "treatment",
      "treatmentGroups",
    ]);
    for (const s of ["disease", "doctorConversation", "progression", "definitions"]) {
      expect(leafSections, `${s} is core-narrated`).not.toContain(s);
    }
  });

  it("every leaf section survives a refresh in which no leaf runs at all", async () => {
    const prior = priorFinding();
    const { client: out } = await orchestrateRefresh({ ...client(), finding: prior } as Client, {
      generateCore: async () => coreOnly(),
      runLeaf: async () => { throw new Error("rate limited"); },
    });
    for (const section of leafSections) {
      expect(out.finding![section], section).toEqual(prior[section]);
    }
  });

  it("and the vault never holds the blanked version, even mid-run", async () => {
    // The original defect was not the end state — it was that the EMPTY finding was persisted first.
    // A crash between that save and the leaves left the patient with nothing.
    const saved: ClientFinding[] = [];
    await orchestrateRefresh({ ...client(), finding: priorFinding() } as Client, {
      generateCore: async () => coreOnly(),
      runLeaf: async (c) => c,
      save: async (c) => { saved.push(c.finding!); },
    });
    expect(saved.length).toBeGreaterThan(0);
    for (const [i, f] of saved.entries()) {
      for (const section of leafSections) {
        expect((f[section] as unknown[]).length, `save #${i} blanked ${section}`).toBeGreaterThan(0);
      }
    }
  });

  it("a leaf that succeeds still replaces the carried-forward answer", async () => {
    const { client: out } = await orchestrateRefresh({ ...client(), finding: priorFinding() } as Client, {
      generateCore: async () => coreOnly(),
      runLeaf: async (c, node) =>
        node === "studyResults"
          ? { ...c, finding: { ...c.finding!, studyResults: [{ study: "s", result: "FRESH", group: "g" }] } as ClientFinding }
          : c,
    });
    expect(out.finding!.studyResults).toEqual([{ study: "s", result: "FRESH", group: "g" }]);
  });

  it("carries nothing forward when there is no prior Finding", () => {
    const core = coreOnly();
    expect(carryForwardLeafSections(undefined, core)).toBe(core);
  });

  it("respects a core that did narrate a section — an older stored response still carries them", () => {
    const core = { ...coreOnly(), studyResults: [{ study: "s", result: "from the core", group: "g" }] } as ClientFinding;
    expect(carryForwardLeafSections(priorFinding(), core).studyResults).toEqual([
      { study: "s", result: "from the core", group: "g" },
    ]);
  });
});

describe("a leaf is stamped fresh when it succeeds, not when the core does", () => {
  // The stamps themselves are correct values — the patient's raw inputs do not change during a run.
  // What was wrong was stamping all nine before any leaf had earned it.
  const hashes = () => Object.fromEntries(leafRegenOrder().map((n) => [n, `hash-${n}`]));
  const stale = (f: ClientFinding) => new Set(driftedKeys(hashes(), f.nodeHashes ?? {}));

  it("a leaf that never ran reads stale, and its sisters do not", async () => {
    const victim = leafRegenOrder()[1];
    const { client: out } = await orchestrateRefresh({ ...client(), finding: priorFinding() } as Client, {
      generateCore: async () => coreOnly(hashes()),
      runLeaf: async (c, node) => { if (node === victim) throw new Error("rate limited"); return c; },
    });
    expect(stale(out.finding!)).toEqual(new Set([victim]));
  });

  it("a clean run leaves nothing stale", async () => {
    const { client: out } = await orchestrateRefresh({ ...client(), finding: priorFinding() } as Client, {
      generateCore: async () => coreOnly(hashes()),
      runLeaf: async (c) => c,
    });
    expect(stale(out.finding!)).toEqual(new Set());
  });

  it("a run cancelled after the core leaves every un-run leaf stale, not falsely fresh", async () => {
    const controller = new AbortController();
    const order = leafRegenOrder();
    const saved: ClientFinding[] = [];
    await expect(
      orchestrateRefresh({ ...client(), finding: priorFinding() } as Client, {
        generateCore: async () => coreOnly(hashes()),
        runLeaf: async (c, node) => { if (node === order[0]) controller.abort(); return c; },
        save: async (c) => { saved.push(c.finding!); },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    // Cancelling was destructive by the same mechanism: whatever was saved must not claim freshness
    // for leaves that never ran.
    expect(stale(saved.at(-1)!)).toEqual(new Set(order.slice(1)));
  });
});

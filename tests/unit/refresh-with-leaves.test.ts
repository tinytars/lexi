import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, ClientFinding } from "../../src/lib/types";

// The two collaborators are mocked, not the orchestrator: this asserts the WIRING that was missing
// — that the provider's refresh reaches every leaf through the same relay the Translate buttons use,
// saving as it goes. finding-refresh.test.ts already covers the ordering itself.
vi.mock("../../src/lib/leaf-regen-client", () => ({
  fetchLeafRegen: vi.fn(),
  applyLeafRegen: vi.fn(),
}));
import { fetchLeafRegen, applyLeafRegen } from "../../src/lib/leaf-regen-client";
import { refreshFindingWithLeaves } from "../../src/lib/refresh-client";
import { leafRegenOrder } from "../../src/lib/finding-refresh";

const CORE = { disease: [], marker: "core" } as unknown as ClientFinding;
const client = () => ({ displayName: "Pablo", results: [] }) as unknown as Client;

const generateCore = async () => CORE;

beforeEach(() => {
  vi.mocked(fetchLeafRegen).mockReset();
  vi.mocked(applyLeafRegen).mockReset();
});

describe("refreshFindingWithLeaves", () => {
  it("runs every leaf after the core, and saves after each", async () => {
    vi.mocked(fetchLeafRegen).mockImplementation(async (_c, node) => ({ node, validated: {}, inputHash: "h" }));
    vi.mocked(applyLeafRegen).mockImplementation(async (c) => c);
    const saved: number[] = [];
    const stages: string[] = [];

    const { failures } = await refreshFindingWithLeaves(client(), "tok", "pablo", {
      generateCore,
      onStage: (s) => { if (s.index > 0) stages.push(s.node!); },
      save: async () => { saved.push(1); },
    });

    expect(failures).toEqual([]);
    expect(stages).toEqual(leafRegenOrder());
    // One save for the core plus one per leaf — the cadence that makes a cancel keep what landed.
    expect(saved).toHaveLength(leafRegenOrder().length + 1);
  });

  it("records a failed leaf and keeps going, rather than losing the core", async () => {
    const order = leafRegenOrder();
    vi.mocked(fetchLeafRegen).mockImplementation(async (_c, node) => {
      if (node === order[1]) throw new Error("rate limited");
      return { node, validated: {}, inputHash: "h" };
    });
    vi.mocked(applyLeafRegen).mockImplementation(async (c) => c);

    const { client: out, failures } = await refreshFindingWithLeaves(client(), "tok", "pablo", { generateCore });

    expect(failures.map((f) => f.node)).toEqual([order[1]]);
    expect(failures[0].message).toBe("rate limited");
    // The core's own sections survived the leaf failure. Identity equality (`toBe(CORE)`) used to
    // hold and no longer does: W71 un-stamps the leaves' nodeHashes so a leaf that never ran reads
    // stale rather than falsely fresh, which necessarily returns a new object. The claim being made
    // here was never about identity.
    expect(out.finding).toMatchObject({ disease: CORE.disease, marker: (CORE as unknown as { marker: string }).marker });
  });

  it("leaves an empty node untouched instead of merging nothing over it", async () => {
    vi.mocked(fetchLeafRegen).mockResolvedValue(null);
    await refreshFindingWithLeaves(client(), "tok", "pablo", { generateCore });
    expect(applyLeafRegen).not.toHaveBeenCalled();
  });
});

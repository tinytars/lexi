import { describe, it, expect, vi, beforeEach } from "vitest";
import { planFindingRefresh, nodeHashesOf } from "../../scripts/factors";
import { runLeafRegen } from "../../src/lib/leaf-regen-anthropic";
import { leafContextFor, mergeLeafResult } from "../../src/lib/leaf-regen-registry";
import { modelId } from "../../src/lib/model-config";
import type { Client } from "../../src/lib/types";

// A fake client for the treatmentGroups leaf wiring test; the pure planFindingRefresh tests don't
// touch it. runLeafRegen streams, so it exposes stream().finalMessage().
const create = vi.fn();
const llm = {
  client: { messages: { stream: (...args: unknown[]) => ({ finalMessage: () => create(...args) }) } } as never,
  model: modelId("leafRegen"),
};

function ai(intervention: string, purpose = "") {
  return { intervention, purpose, pros: [], cons: [], alternatives: [], recommendation: "" };
}

function baseClient(): Client {
  return {
    displayName: "Alex",
    dob: "1980-01-01",
    gender: "male",
    watchlist: ["ApoB"],
    results: [{ marker: "ApoB", group: "Lipids", source: "lab", date: "2026-01-01", value: 80, unit: "mg/dL" }],
    factors: {
      decisions: [{ intervention: "Methylation stack", purpose: "overnight HRV" }],
      treatments: [{ name: "Start statin or statin-like approach", kind: "behavior", start: "2099-06" }],
    },
    finding: {
      disease: [
        { group: "Cardiovascular Risk", finding: "x" },
        { group: "Methylation / Nutrient Status", finding: "y" },
      ],
      decisions: { patient: [], ai: [ai("Rosuvastatin", "Cut ApoB"), ai("PCSK9 inhibitor", "Escalation")] },
    },
  } as unknown as Client;
}

// A client whose stored nodeHashes match the current inputs, then optionally corrupted per-node.
function stamped(overrides: Record<string, string> = {}): Client {
  const c = baseClient();
  c.finding!.nodeHashes = { ...nodeHashesOf(c), ...overrides };
  return c;
}

describe("planFindingRefresh (W15d)", () => {
  it("up-to-date when every node hash matches", () => {
    expect(planFindingRefresh(stamped(), false)).toEqual({ kind: "up-to-date" });
  });

  it("full regen when forced, when there's no finding, or a pre-W15b finding has no nodeHashes", () => {
    expect(planFindingRefresh(stamped(), true).kind).toBe("full");
    const noFinding = baseClient();
    delete noFinding.finding;
    expect(planFindingRefresh(noFinding, false)).toMatchObject({ kind: "full", reason: /no existing finding/ });
    const preW15b = baseClient();
    delete preW15b.finding!.nodeHashes;
    expect(planFindingRefresh(preW15b, false)).toMatchObject({ kind: "full", reason: /pre-W15b/ });
  });

  it("leaf-only when just the extracted treatmentGroups leaf is stale", () => {
    expect(planFindingRefresh(stamped({ treatmentGroups: "stale00" }), false)).toEqual({
      kind: "leaf-only",
      leaves: ["treatmentGroups"],
      lagging: [],
    });
  });

  it("leaf-only with the whole-report summary flagged as lagging (not re-stamped)", () => {
    expect(planFindingRefresh(stamped({ treatmentGroups: "stale00", finalThoughts: "stale00" }), false)).toEqual({
      kind: "leaf-only",
      leaves: ["treatmentGroups"],
      lagging: ["finalThoughts"],
    });
  });

  it("summaries-lagging when only a tolerant summary is stale (no core regen forced)", () => {
    expect(planFindingRefresh(stamped({ finalThoughts: "stale00" }), false)).toEqual({
      kind: "summaries-lagging",
      lagging: ["finalThoughts"],
    });
  });

  it("leaf-only when two extracted leaves are stale together (M66 — aiOnPlan now peeled out)", () => {
    // aiOnPlan is stale alongside treatmentGroups after a plan edit; both are leaf-regenerable now
    // (finding-dag.ts + LEAF_REGENERABLE), so this no longer forces the full path.
    expect(planFindingRefresh(stamped({ treatmentGroups: "stale00", aiOnPlan: "stale00" }), false)).toEqual({
      kind: "leaf-only",
      leaves: ["aiOnPlan", "treatmentGroups"],
      lagging: [],
    });
  });

  it("the three W65 leaves route leaf-only too, instead of forcing a $7 core regen", () => {
    // allergyResults/familyResults/diseaseResults gained specs in W65 but the hand-written
    // LEAF_REGENERABLE list lagged, so adding one allergy paid for a full monolith regen. The set is
    // derived from LEAF_REGEN_SPECS now; this is the behaviour that proves it.
    for (const node of ["allergyResults", "familyResults", "diseaseResults"]) {
      expect(planFindingRefresh(stamped({ [node]: "stale00" }), false)).toEqual({
        kind: "leaf-only",
        leaves: [node],
        lagging: [],
      });
    }
  });

  it("a real watchlist edit currently routes to full (healthMarkers not yet extracted)", () => {
    const c = stamped();
    c.watchlist = ["ApoB", "LDL"]; // dirties healthMarkers only
    expect(planFindingRefresh(c, false)).toMatchObject({ kind: "full", reason: /healthMarkers/ });
  });
});

describe("treatmentGroups leaf wiring (W15d; single-path since W65)", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "k";
    create.mockReset();
    create.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "emit_treatment_groups",
          input: {
            groups: [
              { system: "S1", topic: "Lipid-lowering", patient: ["A1"], ai: ["AI1", "AI2"] },
              { system: "S2", topic: "Methyl donors", patient: ["P1"], ai: [] },
            ],
          },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  });

  it("forces the tool and resolves the id-refs to the stored TreatmentGroup shape", async () => {
    const c = baseClient();
    const outcome = await runLeafRegen({ ...llm, node: "treatmentGroups", inputs: leafContextFor("treatmentGroups", c) });
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    const arg = create.mock.calls[0][0] as { tool_choice?: { name: string }; model: string };
    expect(arg.tool_choice).toEqual({ type: "tool", name: "emit_treatment_groups" });
    expect(arg.model).toBe(modelId("leafRegen"));
    const groups = mergeLeafResult(c, "treatmentGroups", outcome.result).finding!.treatmentGroups;
    expect(groups).toEqual([
      { system: "Cardiovascular Risk", topic: "Lipid-lowering", patient: ["Start statin or statin-like approach"], ai: ["Rosuvastatin", "PCSK9 inhibitor"] },
      { system: "Methylation / Nutrient Status", topic: "Methyl donors", patient: ["Methylation stack"], ai: [] },
    ]);
  });

  it("reports no_tool_use when the model emits no tool call", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "no" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const outcome = await runLeafRegen({ ...llm, node: "treatmentGroups", inputs: leafContextFor("treatmentGroups", baseClient()) });
    expect(outcome.kind).toBe("no_tool_use");
  });
});

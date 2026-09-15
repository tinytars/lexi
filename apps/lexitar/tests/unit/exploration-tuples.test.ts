import { describe, it, expect } from "vitest";
import { buildExplorationRows, tuplesOf, explorationTuples } from "../../src/lib/exploration-rows";
import { explorationItemAnchor } from "../../src/lib/anchor";
import type { Client } from "../../src/lib/types";

// Exploration was the last section whose items were not addressable cells. A tuple is one item —
// the LexiTar half of a turn the patient never took.
const client = (): Client =>
  ({
    finding: {
      disease: [{ group: "Cardiovascular Risk", finding: "x" }],
      dataRequisition: [
        { type: "Blood", group: "Cardiovascular Risk", items: ["[new] ApoB", "[due soon] Lp(a)", "Homocysteine"] },
        { type: "Imaging", group: "Cardiovascular Risk", items: ["[overdue] CAC score"] },
      ],
    },
  }) as unknown as Client;

describe("tuplesOf", () => {
  it("splits a requisition cell into one tuple per item, items before dueSoon", () => {
    const [blood] = buildExplorationRows(client());
    const tuples = tuplesOf(blood);
    expect(tuples.map((t) => t.text)).toEqual(["[new] ApoB", "Homocysteine", "[due soon] Lp(a)"]);
    expect(tuples.map((t) => t.side)).toEqual(["items", "items", "dueSoon"]);
  });

  it("indexes WITHIN each side, so the anchor matches what search-index resolves to", () => {
    const [blood] = buildExplorationRows(client());
    const tuples = tuplesOf(blood);
    expect(tuples.map((t) => t.index)).toEqual([0, 1, 0]);
    for (const t of tuples) {
      expect(t.anchor).toBe(explorationItemAnchor(t.group, t.type, t.side, t.index));
    }
    // Each item is its own DOM node now, so anchors must be distinct.
    expect(new Set(tuples.map((t) => t.anchor)).size).toBe(tuples.length);
  });

  it("carries the owning system and modality onto every tuple", () => {
    const [blood] = buildExplorationRows(client());
    for (const t of tuplesOf(blood)) {
      expect(t.group).toBe("Cardiovascular Risk");
      expect(t.type).toBe("Blood");
    }
  });
});

describe("explorationTuples", () => {
  it("flattens every modality cell into individual items", () => {
    const tuples = explorationTuples(client());
    expect(tuples.map((t) => t.text)).toEqual([
      "[new] ApoB", "Homocysteine", "[due soon] Lp(a)", "[overdue] CAC score",
    ]);
  });

  it("is empty for a client with no requisition", () => {
    expect(explorationTuples({ finding: {} } as unknown as Client)).toEqual([]);
  });
});

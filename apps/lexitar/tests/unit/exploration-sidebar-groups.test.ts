import { describe, it, expect } from "vitest";
import { explorationSidebarGroups, explorationGroupsPending } from "../../src/lib/exploration-sidebar-groups";
import type { Client } from "../../src/lib/types";

describe("explorationSidebarGroups", () => {
  it("is empty when System Analysis isn't established", () => {
    const client = { finding: undefined, factors: {} } as unknown as Client;
    expect(explorationSidebarGroups(client)).toEqual([]);
  });

  it("emits an All row first, then one row per systemOrder entry, in that order (W61)", () => {
    const client = {
      finding: {
        disease: [
          { group: "Cardiovascular Risk", finding: "x" },
          { group: "Metabolic Health", finding: "y" },
        ],
        dataRequisition: [
          { type: "Lipid panel", group: "Cardiovascular Risk", items: ["ApoB"] },
          { type: "A1c", group: "Metabolic Health", items: ["Hemoglobin A1c"] },
        ],
      },
      factors: {},
    } as unknown as Client;
    const rows = explorationSidebarGroups(client);
    expect(rows.map((r) => r.key)).toEqual(["ungrouped", "Cardiovascular Risk", "Metabolic Health"]);
    // All spans every system.
    expect(rows[0].label).toBe("All");
    expect(rows[0].count).toBe(2);
    expect(rows[0].children!.map((c) => c.label)).toEqual(["ApoB", "Hemoglobin A1c"]);
    expect(rows[1].count).toBe(1);
    expect(rows[1].children!.map((c) => c.label)).toEqual(["ApoB"]);
    expect(rows[2].count).toBe(1);
    expect(rows[2].children!.map((c) => c.label)).toEqual(["Hemoglobin A1c"]);
  });

  it("counts flattened items across multiple modality cells sharing a system, not the cell count", () => {
    const client = {
      finding: {
        disease: [{ group: "Cardiovascular Risk", finding: "x" }],
        dataRequisition: [
          { type: "Lipid panel", group: "Cardiovascular Risk", items: ["ApoB", "Lp(a)"] },
          { type: "Imaging", group: "Cardiovascular Risk", items: ["CAC score"] },
        ],
      },
      factors: {},
    } as unknown as Client;
    const rows = explorationSidebarGroups(client);
    expect(rows).toHaveLength(2); // All + the single system
    // W59 — 2 cells, but 3 items total: count is the item count (children.length), not the cell
    // count, so this fixture must NOT collapse to a coincidental 1-item-per-cell case.
    expect(rows[1].count).toBe(3);
    expect(rows[1].children).toHaveLength(3);
    expect(rows[1].children!.map((c) => c.label)).toEqual(["ApoB", "Lp(a)", "CAC score"]);
    expect(rows[0].count).toBe(3);
  });

  it("a client with zero dataRequisition entries still returns one row per system, count 0", () => {
    const client = {
      finding: { disease: [{ group: "Cardiovascular Risk", finding: "x" }], dataRequisition: [] },
      factors: {},
    } as unknown as Client;
    const rows = explorationSidebarGroups(client);
    expect(rows).toEqual([
      { key: "ungrouped", label: "All", count: 0, children: [] },
      { key: "Cardiovascular Risk", label: "Cardiovascular Risk", count: 0, children: [] },
    ]);
  });

  it("skips cells with no items when counting", () => {
    const client = {
      finding: {
        disease: [{ group: "Cardiovascular Risk", finding: "x" }],
        dataRequisition: [
          { type: "Lipid panel", group: "Cardiovascular Risk", items: ["ApoB"] },
          { type: "Empty", group: "Cardiovascular Risk", items: [] },
        ],
      },
      factors: {},
    } as unknown as Client;
    const rows = explorationSidebarGroups(client);
    expect(rows).toHaveLength(2); // All + the single system
    expect(rows[1].count).toBe(1);
    expect(rows[1].children!.map((c) => c.label)).toEqual(["ApoB"]);
  });
});

describe("explorationGroupsPending", () => {
  it("is true when no Finding disease list is established", () => {
    const client = { finding: undefined, factors: {} } as unknown as Client;
    expect(explorationGroupsPending(client)).toBe(true);
  });

  it("is true when finding.disease is an empty list", () => {
    const client = { finding: { disease: [] }, factors: {} } as unknown as Client;
    expect(explorationGroupsPending(client)).toBe(true);
  });

  it("is false once at least one body-system risk is established", () => {
    const client = { finding: { disease: [{ group: "Cardiovascular Risk", finding: "x" }] }, factors: {} } as unknown as Client;
    expect(explorationGroupsPending(client)).toBe(false);
  });
});

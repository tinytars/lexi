import { describe, it, expect } from "vitest";
import { hypothesisSidebarGroups, hypothesisGroupsPending } from "../../src/lib/hypothesis-sidebar-groups";
import type { Client } from "../../src/lib/types";

describe("hypothesisSidebarGroups", () => {
  it("is empty when System Analysis isn't established", () => {
    const client = { finding: undefined, factors: {} } as unknown as Client;
    expect(hypothesisSidebarGroups(client)).toEqual([]);
  });

  it("emits an All row first, then one row per systemOrder entry, in that order (W61)", () => {
    const client = {
      finding: {
        disease: [
          { group: "Cardiovascular Risk", finding: "x" },
          { group: "Metabolic Health", finding: "y" },
        ],
        treatmentGroups: [
          { system: "Cardiovascular Risk", topic: "Statin therapy", patient: [], ai: ["Rosuvastatin"] },
          { system: "Metabolic Health", topic: "Glucose control", patient: [], ai: ["Metformin"] },
        ],
        decisions: { ai: [{ intervention: "Rosuvastatin", purpose: "lower ApoB" }, { intervention: "Metformin", purpose: "lower glucose" }] },
      },
      factors: {},
    } as unknown as Client;
    const rows = hypothesisSidebarGroups(client);
    expect(rows.map((r) => r.key)).toEqual(["ungrouped", "Cardiovascular Risk", "Metabolic Health"]);
    // All spans every system.
    expect(rows[0].label).toBe("All");
    expect(rows[0].count).toBe(2);
    expect(rows[0].children!.map((c) => c.label)).toEqual(["Rosuvastatin", "Metformin"]);
    expect(rows[1].count).toBe(1);
    expect(rows[1].children!.map((c) => c.label)).toEqual(["Rosuvastatin"]);
    expect(rows[2].count).toBe(1);
    expect(rows[2].children!.map((c) => c.label)).toEqual(["Metformin"]);
  });

  it("counts flattened patient+ai ideas across multiple topics sharing a system, not the topic count", () => {
    const client = {
      finding: {
        disease: [{ group: "Cardiovascular Risk", finding: "x" }],
        treatmentGroups: [
          { system: "Cardiovascular Risk", topic: "Statin therapy", patient: ["Atorvastatin"], ai: ["Rosuvastatin"] },
          { system: "Cardiovascular Risk", topic: "Blood pressure control", patient: [], ai: ["Lisinopril"] },
        ],
        decisions: { ai: [{ intervention: "Rosuvastatin", purpose: "a" }, { intervention: "Lisinopril", purpose: "b" }] },
      },
      factors: { decisions: [{ id: "d1", intervention: "Atorvastatin", purpose: "c" }] },
    } as unknown as Client;
    const rows = hypothesisSidebarGroups(client);
    // All + the single system.
    expect(rows).toHaveLength(2);
    // W59 — 2 topics, but 3 ideas total (1 patient + 2 ai): count is the idea count
    // (children.length), not the topic count, so this fixture must NOT collapse to a
    // coincidental 1-idea-per-topic case.
    expect(rows[1].count).toBe(3);
    expect(rows[1].children).toHaveLength(3);
    expect(rows[1].children!.map((c) => c.label)).toEqual(["Atorvastatin", "Rosuvastatin", "Lisinopril"]);
    expect(rows[0].count).toBe(3);
  });

  it("a client with zero decision/AI entries still returns one row per system, count 0", () => {
    const client = {
      finding: { disease: [{ group: "Cardiovascular Risk", finding: "x" }], treatmentGroups: [] },
      factors: {},
    } as unknown as Client;
    expect(hypothesisSidebarGroups(client)).toEqual([
      { key: "ungrouped", label: "All", count: 0, children: [] },
      { key: "Cardiovascular Risk", label: "Cardiovascular Risk", count: 0, children: [] },
    ]);
  });
});

describe("hypothesisGroupsPending", () => {
  it("is true when no Finding disease list is established", () => {
    const client = { finding: undefined, factors: {} } as unknown as Client;
    expect(hypothesisGroupsPending(client)).toBe(true);
  });

  it("is true when finding.disease is an empty list", () => {
    const client = { finding: { disease: [] }, factors: {} } as unknown as Client;
    expect(hypothesisGroupsPending(client)).toBe(true);
  });

  it("is false once at least one body-system risk is established", () => {
    const client = { finding: { disease: [{ group: "Cardiovascular Risk", finding: "x" }] }, factors: {} } as unknown as Client;
    expect(hypothesisGroupsPending(client)).toBe(false);
  });
});

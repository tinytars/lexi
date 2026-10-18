import { describe, it, expect } from "vitest";
import { glossarySidebarGroups } from "../../src/lib/glossary-sidebar-groups";
import type { Client } from "../../src/lib/types";
import { ALL_GROUP_LABEL } from "../../src/lib/sidebar-labels";

function def(term: string, group: string): { term: string; definition: string; group: string } {
  return { term, definition: `${term} definition`, group };
}

describe("glossarySidebarGroups", () => {
  it("always includes an All row (every term, flat), even at 0 count", () => {
    const client = { finding: { disease: [], definitions: [] }, factors: {} } as unknown as Client;
    expect(glossarySidebarGroups(client)[0]).toEqual({ key: "ungrouped", label: ALL_GROUP_LABEL, count: 0, children: [] });
  });

  it("emits one row per systemOrder entry, in that order, with counts from definitions[].group", () => {
    const client = {
      finding: {
        disease: [
          { group: "Cardiovascular Risk", finding: "x" },
          { group: "Metabolic Health", finding: "y" },
        ],
        definitions: [def("ApoB", "Cardiovascular Risk"), def("LDL", "Cardiovascular Risk"), def("A1C", "Metabolic Health")],
      },
      factors: {},
    } as unknown as Client;
    const rows = glossarySidebarGroups(client);
    expect(rows.map((r) => r.key)).toEqual(["ungrouped", "system:Cardiovascular Risk", "system:Metabolic Health"]);
    for (const r of rows) expect(r.children).toHaveLength(r.count!);
    expect(rows[0].children!.map((c) => c.key)).toEqual(["ApoB", "LDL", "A1C"]);
    expect(rows[1].children!.map((c) => c.key)).toEqual(["ApoB", "LDL"]);
    expect(rows[2].children!.map((c) => c.key)).toEqual(["A1C"]);
  });

  it("omits an established system with no terms classified into it yet, and surfaces an unrecognized group under a trailing 'Uncategorized' row", () => {
    const client = {
      finding: {
        disease: [{ group: "Cardiovascular Risk", finding: "x" }],
        definitions: [def("ApoB", "Some Other Group")],
      },
      factors: {},
    } as unknown as Client;
    const rows = glossarySidebarGroups(client);
    expect(rows.map((r) => r.key)).toEqual(["ungrouped", "system:Not yet categorized"]);
    expect(rows[1].count!).toBe(1);
    expect(rows[1].children!.map((c) => c.key)).toEqual(["ApoB"]);
  });

  it("is just the All row when System Analysis isn't established", () => {
    const client = { finding: { disease: [], definitions: [def("ApoB", "Cardiovascular Risk")] }, factors: {} } as unknown as Client;
    const rows = glossarySidebarGroups(client);
    expect(rows).toHaveLength(1);
    expect(rows[0].count!).toBe(1);
    expect(rows[0].children!.map((c) => c.key)).toEqual(["ApoB"]);
  });
});

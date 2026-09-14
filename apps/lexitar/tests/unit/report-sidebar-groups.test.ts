import { describe, it, expect } from "vitest";
import { reportSidebarGroups } from "../../src/lib/report-sidebar-groups";
import type { Client } from "../../src/lib/types";
import { ALL_GROUP_LABEL } from "../../src/lib/sidebar-labels";

function source(id: string, importedAt = "2026-01-01") {
  return { id, sha256: id, kind: "lab" as const, file: `${id}.pdf`, originalName: `${id}.pdf`, importedAt };
}

function disease(id: string, sourceId: string) {
  return { id, date: "2026-01-01", diagnostic: `${id} diagnosis`, sourceId };
}

function result(diseaseId: string, group: string) {
  return { diseaseId, result: `${diseaseId} result`, group };
}

describe("reportSidebarGroups", () => {
  it("always includes an All row (every report, flat), even at 0 count", () => {
    const client = { finding: { disease: [] }, factors: { diseases: [] }, sources: [] } as unknown as Client;
    expect(reportSidebarGroups(client)[0]).toEqual({ key: "ungrouped", label: ALL_GROUP_LABEL, count: 0, children: [] });
  });

  it("emits one row per systemOrder entry, in that order, using each report's FIRST linked diagnosis's group", () => {
    const client = {
      finding: {
        disease: [
          { group: "Cardiovascular Risk", finding: "x" },
          { group: "Metabolic Health", finding: "y" },
        ],
        diseaseResults: [result("dx1", "Cardiovascular Risk"), result("dx2", "Metabolic Health")],
      },
      factors: { diseases: [disease("dx1", "s1"), disease("dx2", "s2")] },
      sources: [source("s1"), source("s2")],
    } as unknown as Client;
    const rows = reportSidebarGroups(client);
    expect(rows.map((r) => r.key)).toEqual(["ungrouped", "system:Cardiovascular Risk", "system:Metabolic Health"]);
    // W58 — every row's children.length matches its own count, and Ungrouped's children are the
    // full flat report list (not scoped to any one system).
    for (const r of rows) expect(r.children).toHaveLength(r.count!);
    expect(rows[0].children!.map((c) => c.key)).toEqual(["s1", "s2"]);
    expect(rows[1].children!.map((c) => c.key)).toEqual(["s1"]);
    expect(rows[2].children!.map((c) => c.key)).toEqual(["s2"]);
  });

  it("lists an untagged report under All only — there is no trailing 'Uncategorized' row (W61)", () => {
    const client = {
      finding: { disease: [{ group: "Cardiovascular Risk", finding: "x" }], diseaseResults: [] },
      factors: { diseases: [] },
      sources: [source("s1")],
    } as unknown as Client;
    const rows = reportSidebarGroups(client);
    expect(rows.map((r) => r.key)).toEqual(["ungrouped"]);
    // Still reachable: All is every report, flat.
    expect(rows[0].children!.map((c) => c.key)).toEqual(["s1"]);
    expect(rows.some((r) => r.label === "Uncategorized")).toBe(false);
  });

  it("is just the All row when System Analysis isn't established", () => {
    const client = {
      finding: { disease: [], diseaseResults: [result("dx1", "Cardiovascular Risk")] },
      factors: { diseases: [disease("dx1", "s1")] },
      sources: [source("s1")],
    } as unknown as Client;
    const rows = reportSidebarGroups(client);
    expect(rows).toHaveLength(1);
    expect(rows[0].count!).toBe(1);
    expect(rows[0].children!.map((c) => c.key)).toEqual(["s1"]);
  });
});

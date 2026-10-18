import { describe, it, expect } from "vitest";
import { analysisItems, analysisItemsFor, analysisSidebarGroups } from "../../src/lib/analysis-items";
import { ANALYSIS_NAV } from "../../src/lib/analysis-nav";
import type { Client } from "../../src/lib/types";

// Analysis's four multi-item blocks each derived their rows privately inside their own component,
// so nothing else could list them. These assert the shared derivation the components now render
// from — if it drifts, the page and the sidebar drift together rather than apart.
const client = (): Client =>
  ({
    displayName: "T",
    finding: {
      progression: { latest: "L", recent: "R", overall: "" },
      planAssessment: "plan read",
      disease: [{ group: "Cardiovascular Risk", finding: "CV read" }, { group: "Hepatic", finding: "" }],
      patternAntipattern: { pattern: "P", antipattern: "" },
      clinicalSynthesis: { adverse: "A", favorable: "F", conditioning: "C" },
      finalThoughts: "FT",
    },
  }) as unknown as Client;

describe("analysis item derivations", () => {
  it("drops empty text rather than emitting a blank cell", () => {
    expect(analysisItemsFor(client(), "progression").map((i) => i.label)).toEqual(["Latest", "Recent"]);
    expect(analysisItemsFor(client(), "pattern").map((i) => i.label)).toEqual(["Patient pattern"]);
    // A disease entry with no finding text contributes nothing.
    expect(analysisItemsFor(client(), "system").map((i) => i.label)).toEqual(["Cardiovascular Risk"]);
  });

  it("names a single-item block after the block itself", () => {
    expect(analysisItemsFor(client(), "final")[0]).toMatchObject({ label: "Final Thoughts", text: "FT" });
    expect(analysisItemsFor(client(), "ontreatment")[0]).toMatchObject({ label: "On Treatment", text: "plan read" });
  });

  it("includes the optional biological-age read only when present", () => {
    expect(analysisItemsFor(client(), "synthesis").map((i) => i.label)).toContain("Biological-age read");
    const without = client();
    delete (without.finding!.clinicalSynthesis as { conditioning?: string }).conditioning;
    expect(analysisItemsFor(without, "synthesis").map((i) => i.label)).not.toContain("Biological-age read");
  });

  it("returns every item in ANALYSIS_NAV order, each with a distinct anchor", () => {
    const items = analysisItems(client());
    const order = items.map((i) => i.section);
    expect(order).toEqual([...order].sort((a, b) =>
      ANALYSIS_NAV.findIndex((n) => n.key === a) - ANALYSIS_NAV.findIndex((n) => n.key === b)));
    expect(new Set(items.map((i) => i.anchor)).size).toBe(items.length);
  });

  it("is empty for a client with no Finding", () => {
    expect(analysisItems({ displayName: "x" } as unknown as Client)).toEqual([]);
  });
});

describe("analysisSidebarGroups", () => {
  it("leads with an All row spanning every item, then one row per block", () => {
    const rows = analysisSidebarGroups(client());
    expect(rows[0]).toMatchObject({ key: "ungrouped", label: "All" });
    expect(rows.slice(1).map((r) => r.key)).toEqual(ANALYSIS_NAV.map((n) => n.key));
    expect(rows[0].count).toBe(analysisItems(client()).length);
  });

  it("counts each block's own items, and All is their sum", () => {
    const rows = analysisSidebarGroups(client());
    const sum = rows.slice(1).reduce((n, r) => n + (r.count ?? 0), 0);
    expect(rows[0].count).toBe(sum);
  });

  it("still lists every block when a client has no Finding, all at zero", () => {
    const rows = analysisSidebarGroups({ displayName: "x" } as unknown as Client);
    expect(rows).toHaveLength(ANALYSIS_NAV.length + 1);
    expect(rows.every((r) => r.count === 0)).toBe(true);
  });
});

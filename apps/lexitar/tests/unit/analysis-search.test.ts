import { describe, it, expect } from "vitest";
import { analysisSearchLeaves } from "../../src/lib/search-index";
import { analysisItems } from "../../src/lib/analysis-items";
import { ANALYSIS_NAV } from "../../src/lib/analysis-nav";
import type { Client } from "../../src/lib/types";

// W62 — search used to re-derive all six Analysis blocks itself (~107 lines) and had drifted: the
// same item was named one thing in search and another in the app. Both read analysis-items.ts now.
function client(): Client {
  return {
    displayName: "A", dob: "1980-01-01", gender: "male", watchlist: [], results: [],
    finding: {
      progression: { latest: "L", recent: "R", overall: "O" },
      planAssessment: "the plan read",
      disease: [{ group: "Cardiovascular Risk", finding: "cv finding" }],
      patternAntipattern: { pattern: "p", antipattern: "ap" },
      clinicalSynthesis: { adverse: "a", favorable: "f", conditioning: "c" },
      finalThoughts: "closing",
    },
  } as unknown as Client;
}

describe("analysisSearchLeaves", () => {
  it("returns exactly the items the body renders, with the same anchors", () => {
    const leaves = analysisSearchLeaves(client());
    const items = analysisItems(client());
    expect(leaves.map((l) => l.anchor)).toEqual(items.map((i) => i.anchor));
    expect(leaves.map((l) => l.label)).toEqual(items.map((i) => i.label));
  });

  // The three that had drifted. Search said "Plan assessment"/"System"/"Final thoughts" where the
  // app said "On Treatment"/"System Analysis"/"Final Thoughts".
  it("names each item the way the app does", () => {
    const labels = analysisSearchLeaves(client()).map((l) => l.label);
    expect(labels).toContain("On Treatment");
    expect(labels).toContain("Final Thoughts");
    expect(labels).not.toContain("Plan assessment");
    expect(labels).not.toContain("Final thoughts");
    expect(labels).not.toContain("System");
  });

  it("tags each hit with its block, from the one nav table", () => {
    const blocks = new Set(ANALYSIS_NAV.map((n) => n.label));
    for (const l of analysisSearchLeaves(client())) expect(blocks.has(l.context!)).toBe(true);
  });

  it("carries the item text as the body, so a preview can render it", () => {
    const l = analysisSearchLeaves(client()).find((x) => x.label === "Final Thoughts")!;
    expect(l.body).toBe("closing");
    expect(l.searchText).toContain("closing");
  });
});

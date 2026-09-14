import { describe, it, expect } from "vitest";
import { recommendedMarkerGroups, recommendedMarkersSidebarGroups } from "../../src/lib/recommended-markers-sidebar-groups";
import { recommendedMarkerSearchLeaves } from "../../src/lib/search-index";
import { healthMarkersGroupAnchor, healthMarkersAnchor } from "../../src/lib/anchor";
import { notesSidebarGroups } from "../../src/lib/sidebar-leaf-rows";
import type { Client } from "../../src/lib/types";

const client = (): Client =>
  ({
    displayName: "T",
    finding: {
      healthMarkers: {
        recommended: [
          { group: "Cardiovascular Risk", markers: [{ name: "ApoB", rationale: "why apob" }, { name: "Lp(a)", rationale: "why lpa" }] },
          { group: "Body Composition", markers: [{ name: "DEXA", rationale: "why dexa" }] },
          // A group the AI emitted with no markers must not become an empty cell.
          { group: "Hepatic", markers: [] },
        ],
      },
    },
  }) as unknown as Client;

describe("recommendedMarkerGroups", () => {
  it("drops a group with no markers rather than rendering an empty cell", () => {
    expect(recommendedMarkerGroups(client()).map((g) => g.group)).toEqual(["Cardiovascular Risk", "Body Composition"]);
  });

  it("is empty for a client with no Finding", () => {
    expect(recommendedMarkerGroups({ displayName: "x" } as unknown as Client)).toEqual([]);
  });
});

describe("recommendedMarkersSidebarGroups", () => {
  it("lists one row per GROUP, matching the cells the page renders", () => {
    const [all] = recommendedMarkersSidebarGroups(client());
    expect(all).toMatchObject({ key: "ungrouped", label: "All", count: 2 });
    expect(all.children!.map((c) => c.label)).toEqual(["Cardiovascular Risk", "Body Composition"]);
    // The cell's own anchor, not any single marker's.
    expect(all.children![0].anchor).toBe(healthMarkersGroupAnchor("Cardiovascular Risk"));
  });

  it("still returns the All row at zero when there is nothing recommended", () => {
    const rows = recommendedMarkersSidebarGroups({ displayName: "x" } as unknown as Client);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(0);
  });
});

describe("Notes hosts it between Questions and Glossary", () => {
  const withAll = (): Client => {
    const c = client() as Client & { finding: Record<string, unknown> };
    c.finding.doctorConversation = [{ group: "Cardiovascular Risk", questions: ["Ask about ApoB"] }];
    c.finding.definitions = [{ term: "ApoB", definition: "a protein", group: "Cardiovascular Risk" }];
    (c as Client).factors = { noteEntries: [{ id: "n1", text: "a note" }] } as never;
    return c;
  };

  it("sits between Questions and Glossary", () => {
    const keys = notesSidebarGroups(withAll()).map((r) => r.key);
    expect(keys[0]).toBe("ungrouped");
    expect(keys).toContain("healthMarkers");
    expect(keys).toContain("definitions");
    // Order is what matters: whatever else is present, Recommended Markers follows Questions (when
    // Questions has any) and precedes Glossary.
    expect(keys.indexOf("healthMarkers")).toBeLessThan(keys.indexOf("definitions"));
    if (keys.includes("docInference")) {
      expect(keys.indexOf("docInference")).toBeLessThan(keys.indexOf("healthMarkers"));
    }
  });

  it("omits the row entirely when nothing is recommended", () => {
    const c = withAll();
    c.finding!.healthMarkers = { recommended: [] };
    expect(notesSidebarGroups(c).map((r) => r.key)).not.toContain("healthMarkers");
  });
});

describe("recommendedMarkerSearchLeaves", () => {
  it("indexes one leaf per MARKER — finer than the sidebar, because a search looks for a marker", () => {
    const leaves = recommendedMarkerSearchLeaves(client());
    expect(leaves.map((l) => l.label)).toEqual(["ApoB", "Lp(a)", "DEXA"]);
    expect(leaves[0]).toMatchObject({ section: "healthMarkers", context: "Cardiovascular Risk" });
    expect(leaves[0].anchor).toBe(healthMarkersAnchor("Cardiovascular Risk", "ApoB"));
  });

  it("searches the rationale too, not just the name", () => {
    expect(recommendedMarkerSearchLeaves(client())[0].searchText).toContain("why apob");
  });
});

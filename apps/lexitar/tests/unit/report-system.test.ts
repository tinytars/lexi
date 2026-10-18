import { describe, it, expect } from "vitest";
import { reportSystemLookup, reportSidebarGroups } from "../../src/lib/report-sidebar-groups";
import { filterByGroup } from "@tinytars/frame/group-filter";
import type { Client, SourceRecord } from "../../src/lib/types";
import { ALL_GROUP_KEY } from "../../src/lib/sidebar-labels";

// W62 — Reports' system rows did nothing: HealthReports declared activeGroup and never read it.
// The fix filters the body with the SAME lookup the sidebar groups by, so the two cannot disagree
// about where a report lives. The seeded e2e vault has no diagnosis-tagged reports (its sidebar
// shows only the All row), so the rule is pinned here instead.

const src = (id: string): SourceRecord =>
  ({ id, sha256: id, kind: "lab", file: `${id}.xlsx`, originalName: `${id}.xlsx`, importedAt: "2026-01-01" }) as SourceRecord;

function client(): Client {
  return {
    displayName: "A", dob: "1980-01-01", gender: "male", watchlist: [], results: [],
    sources: [src("s1"), src("s2"), src("untagged")],
    factors: {
      diseases: [
        { id: "d1", date: "2026-01-01", diagnostic: "Dyslipidemia", sourceId: "s1" },
        { id: "d2", date: "2026-01-01", diagnostic: "Steatosis", sourceId: "s2" },
      ],
    },
    finding: {
      // systemOrder() reads finding.disease[].group — that is what "establishes" a body system, and
      // without it groupBySystem returns null and no system row is emitted at all.
      disease: [{ group: "Cardiovascular Risk" }, { group: "Hepatic" }],
      diseaseResults: [
        { diseaseId: "d1", group: "Cardiovascular Risk" },
        { diseaseId: "d2", group: "Hepatic" },
      ],
    },
  } as unknown as Client;
}

describe("reportSystemLookup", () => {
  it("reads a report's system from its first linked diagnosis", () => {
    const systemOf = reportSystemLookup(client());
    expect(systemOf("s1")).toBe("Cardiovascular Risk");
    expect(systemOf("s2")).toBe("Hepatic");
  });

  it("returns undefined for a report with no tagged diagnosis", () => {
    expect(reportSystemLookup(client())("untagged")).toBeUndefined();
  });

  // The body filters with this; the sidebar groups with it. Same input, same answer.
  it("selects exactly the reports the matching sidebar row lists", () => {
    const c = client();
    const systemOf = reportSystemLookup(c);
    const key = (s: SourceRecord) => (systemOf(s.id) ? `system:${systemOf(s.id)}` : undefined);

    const shown = filterByGroup(c.sources!, "system:Cardiovascular Risk", key, ALL_GROUP_KEY);
    expect(shown.map((s) => s.id)).toEqual(["s1"]);

    const row = reportSidebarGroups(c).find((g) => g.key === "system:Cardiovascular Risk");
    expect(row?.count).toBe(shown.length);
  });

  it("All shows every report, tagged or not", () => {
    const c = client();
    const systemOf = reportSystemLookup(c);
    const shown = filterByGroup(c.sources!, ALL_GROUP_KEY, (s) => (systemOf(s.id) ? `system:${systemOf(s.id)}` : undefined), ALL_GROUP_KEY);
    expect(shown).toHaveLength(3);
  });
});

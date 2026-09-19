import { describe, it, expect } from "vitest";
import type { Client } from "../../src/lib/types";
import type { SidebarVerb } from "../../src/lib/sidebar-actions";
import { lowerZoneKindFor, lowerZoneModel, type LowerZoneKind } from "../../src/lib/sidebar-lower-zone";
import { markerSidebarGroups } from "../../src/lib/marker-sidebar-groups";
import { treatmentSidebarBuckets } from "../../src/lib/treatment-sidebar";
import { hypothesisSidebarGroups } from "../../src/lib/hypothesis-sidebar-groups";
import { explorationSidebarGroups } from "../../src/lib/exploration-sidebar-groups";
import { questionsSidebarGroups } from "../../src/lib/questions-sidebar-groups";
import { glossarySidebarGroups } from "../../src/lib/glossary-sidebar-groups";
import { reportSidebarGroups } from "../../src/lib/report-sidebar-groups";
import { allergySidebarRows, familySidebarRows, notesSidebarGroups, studySidebarGroups } from "../../src/lib/sidebar-leaf-rows";
import { syntheticClient } from "../fixtures/synthetic-patient";

const TODAY = "2026-09-19";
const noAction = () => {};

describe("lowerZoneKindFor", () => {
  it("is chat on the chat tab whatever `active` holds, since there it is a thread id", () => {
    expect(lowerZoneKindFor("chat", "markers")).toBe("chat");
    expect(lowerZoneKindFor("chat", null)).toBe("chat");
  });

  it.each([
    ["markers", "markers"],
    ["healthReports", "healthReports"],
    ["treatment", "treatment"],
    ["personalization", "personalization"],
    ["allergies", "personalization"],
    ["familyHistory", "personalization"],
    ["notes", "notes"],
    ["docInference", "questions"],
    ["definitions", "glossary"],
    ["futureTreatment", "hypothesis"],
    ["study", "study"],
    ["analysis", "analysis"],
    ["exploration", "exploration"],
  ])("maps section %s to the %s zone", (section, kind) => {
    expect(lowerZoneKindFor("labs", section)).toBe(kind);
  });

  it("has no zone for a section without one, an unknown key, or nothing active", () => {
    expect(lowerZoneKindFor("doctor", "healthMarkers")).toBeNull();
    expect(lowerZoneKindFor("labs", "constructor")).toBeNull();
    expect(lowerZoneKindFor("labs", null)).toBeNull();
  });
});

describe("lowerZoneModel", () => {
  const client = syntheticClient("lz");

  it("is empty without a client or a zone", () => {
    const empty = { groupRows: [], pendingNote: null, leafRows: [] };
    expect(lowerZoneModel("markers", null, "markers", TODAY, noAction)).toEqual(empty);
    expect(lowerZoneModel(null, client, null, TODAY, noAction)).toEqual(empty);
  });

  it.each<[LowerZoneKind, (c: Client) => unknown]>([
    ["markers", markerSidebarGroups],
    ["treatment", (c) => treatmentSidebarBuckets(c, TODAY)],
    ["hypothesis", hypothesisSidebarGroups],
    ["exploration", explorationSidebarGroups],
    ["healthReports", reportSidebarGroups],
    ["notes", notesSidebarGroups],
    ["study", studySidebarGroups],
    ["questions", questionsSidebarGroups],
    ["glossary", glossarySidebarGroups],
  ])("builds the %s zone's group rows from its own builder", (kind, build) => {
    expect(lowerZoneModel(kind, client, null, TODAY, noAction).groupRows).toEqual(build(client));
  });

  it("leaves chat and analysis group rows to the sidebar, which builds them from threads and analysis items", () => {
    expect(lowerZoneModel("chat", client, null, TODAY, noAction).groupRows).toEqual([]);
    expect(lowerZoneModel("analysis", client, null, TODAY, noAction).groupRows).toEqual([]);
  });

  it("lists Bio/Allergies/Family under Profile, with counts and add actions routed to onAction", () => {
    const fired: [string, SidebarVerb][] = [];
    const rows = lowerZoneModel("personalization", client, "personalization", TODAY, (k, v) => fired.push([k, v])).groupRows;
    expect(rows.map((r) => [r.key, r.label, r.count])).toEqual([
      ["personalization", "Bio", undefined],
      ["allergies", "Allergies", allergySidebarRows(client).length],
      ["familyHistory", "Family", familySidebarRows(client).length],
    ]);
    rows[1].action!.onClick();
    rows[2].action!.onClick();
    expect(fired).toEqual([["allergies", "add"], ["familyHistory", "add"]]);
  });

  it("shows item rows only for the active Allergies or Family child of Profile", () => {
    expect(lowerZoneModel("personalization", client, "allergies", TODAY, noAction).leafRows).toEqual(allergySidebarRows(client));
    expect(lowerZoneModel("personalization", client, "familyHistory", TODAY, noAction).leafRows).toEqual(familySidebarRows(client));
    expect(lowerZoneModel("personalization", client, "personalization", TODAY, noAction).leafRows).toEqual([]);
    expect(lowerZoneModel("notes", client, "allergies", TODAY, noAction).leafRows).toEqual([]);
  });

  it("notes pending body-system grouping only for the zones grouped by body system", () => {
    const ungrouped: Client = { ...client, finding: undefined, markerGroups: undefined };
    for (const kind of ["markers", "hypothesis", "exploration"] as const) {
      expect(lowerZoneModel(kind, ungrouped, null, TODAY, noAction).pendingNote).toMatch(/^Grouped by body system once the .+ Translation runs\.$/);
    }
    expect(lowerZoneModel("notes", ungrouped, null, TODAY, noAction).pendingNote).toBeNull();
  });
});

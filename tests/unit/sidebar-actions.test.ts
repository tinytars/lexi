import { describe, it, expect } from "vitest";
import { sidebarActionFor } from "../../src/lib/sidebar-actions";

describe("sidebar actions", () => {
  it("chat has a New chat action with no section", () => {
    expect(sidebarActionFor("chat")?.label).toBe("New chat");
  });

  it("each doctor/appointment/ai add-action returns its exact label", () => {
    expect(sidebarActionFor("treatment")?.label).toBe("Add treatment");
    expect(sidebarActionFor("allergies")?.label).toBe("Add allergy");
    expect(sidebarActionFor("familyHistory")?.label).toBe("Add family history");
    expect(sidebarActionFor("notes")?.label).toBe("Add note");
    expect(sidebarActionFor("study")?.label).toBe("Add study");
    expect(sidebarActionFor("futureTreatment")?.label).toBe("Add idea");
  });

  // M84 — Markers/Reports gained their own "+" (both open the same Import modal).
  it("Markers/Reports have an Import add-action", () => {
    expect(sidebarActionFor("markers")?.label).toBe("Import spreadsheet");
    expect(sidebarActionFor("healthReports")?.label).toBe("Import report");
  });

  it("no-action sections and tabs return undefined", () => {
    expect(sidebarActionFor("docInference")).toBeUndefined();
    expect(sidebarActionFor("definitions")).toBeUndefined();
    expect(sidebarActionFor("analysis")).toBeUndefined();
    expect(sidebarActionFor("personalization")).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import {
  resolveNestedSection,
  decideHashSync,
  resolveDefaultGroup,
  NESTED_IN_NOTES,
  GROUP_SECTIONS,
  FIRST_SYSTEM_DEFAULT_SECTIONS,
  SECTION_DEFAULT_GROUP,
  ANCHOR_ELIGIBLE_SECTIONS,
} from "../../src/lib/nav-decisions";

describe("resolveNestedSection", () => {
  it("redirects a nested-in-notes key to notes with that group", () => {
    expect(resolveNestedSection("docInference")).toEqual(["notes", "docInference"]);
    expect(resolveNestedSection("healthMarkers")).toEqual(["notes", "healthMarkers"]);
    expect(resolveNestedSection("definitions")).toEqual(["notes", "definitions"]);
  });

  it("leaves an ordinary section alone, with no group", () => {
    expect(resolveNestedSection("markers")).toEqual(["markers", null]);
  });

  it("passes null through unchanged", () => {
    expect(resolveNestedSection(null)).toEqual([null, null]);
  });

  it("NESTED_IN_NOTES holds exactly the three redirected keys", () => {
    expect([...NESTED_IN_NOTES].sort()).toEqual(["definitions", "docInference", "healthMarkers"]);
  });
});

describe("decideHashSync", () => {
  it("pushes when client+tab (the coarse key) changes", () => {
    const result = decideHashSync({ selectedClientId: "liz", activeTab: "reports" }, "pablo|reports");
    expect(result).toEqual({ mode: "push", nextLastCoarse: "liz|reports" });
  });

  it("replaces when client+tab is unchanged, even if section differs", () => {
    const result = decideHashSync({ selectedClientId: "liz", activeTab: "reports" }, "liz|reports");
    expect(result).toEqual({ mode: "replace", nextLastCoarse: "liz|reports" });
  });

  it("treats a null selectedClientId as its own coarse value", () => {
    const result = decideHashSync({ selectedClientId: null, activeTab: "reports" }, "|reports");
    expect(result).toEqual({ mode: "replace", nextLastCoarse: "|reports" });
  });
});

describe("resolveDefaultGroup", () => {
  it("prefers a remembered group over any default", () => {
    expect(resolveDefaultGroup("markers", "cardio", "endocrine", "ungrouped")).toBe("cardio");
  });

  it("falls back to the first-system default for futureTreatment/exploration", () => {
    expect(FIRST_SYSTEM_DEFAULT_SECTIONS.has("futureTreatment")).toBe(true);
    expect(resolveDefaultGroup("futureTreatment", null, "endocrine", "ungrouped")).toBe("endocrine");
  });

  it("first-system default can itself be null (no established systems yet)", () => {
    expect(resolveDefaultGroup("exploration", null, null, "ungrouped")).toBeNull();
  });

  it("falls back to the section's named default (treatment -> medicine)", () => {
    expect(SECTION_DEFAULT_GROUP.treatment).toBe("medicine");
    expect(resolveDefaultGroup("treatment", null, null, "ungrouped")).toBe("medicine");
  });

  it("falls back to ALL_GROUP_KEY for a section with no named default", () => {
    expect(resolveDefaultGroup("notes", null, null, "ungrouped")).toBe("ungrouped");
  });
});

describe("GROUP_SECTIONS / ANCHOR_ELIGIBLE_SECTIONS", () => {
  it("every anchor-eligible section is also group-bearing", () => {
    for (const s of ANCHOR_ELIGIBLE_SECTIONS) expect(GROUP_SECTIONS.has(s)).toBe(true);
  });

  it("notes is group-bearing but not anchor-eligible", () => {
    expect(GROUP_SECTIONS.has("notes")).toBe(true);
    expect(ANCHOR_ELIGIBLE_SECTIONS.has("notes")).toBe(false);
  });
});

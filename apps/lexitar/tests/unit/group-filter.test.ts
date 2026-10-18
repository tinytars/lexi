import { describe, it, expect } from "vitest";
import { isAllGroup, filterByGroup, resolveGroup } from "@tinytars/frame/group-filter";
import { ALL_GROUP_KEY } from "../../src/lib/sidebar-labels";

// The rule every section now shares. Two sections used to resolve the active group with a fallback
// to groups[0], so selecting an EMPTY group rendered the FIRST group's cells — the click looked
// ignored, or worse, those cells looked like they belonged to the group you picked.
const items = [
  { id: "a", system: "Cardiovascular Risk" },
  { id: "b", system: "Body Composition" },
  { id: "c", system: "Cardiovascular Risk" },
];

describe("isAllGroup", () => {
  it("treats All, null and undefined as show-everything", () => {
    expect(isAllGroup("ungrouped", ALL_GROUP_KEY)).toBe(true);
    expect(isAllGroup(null, ALL_GROUP_KEY)).toBe(true);
    expect(isAllGroup(undefined, ALL_GROUP_KEY)).toBe(true);
    expect(isAllGroup("", ALL_GROUP_KEY)).toBe(true);
  });

  it("treats a named group as a filter", () => {
    expect(isAllGroup("Cardiovascular Risk", ALL_GROUP_KEY)).toBe(false);
  });
});

describe("filterByGroup", () => {
  it("returns everything for All", () => {
    expect(filterByGroup(items, "ungrouped", (i) => i.system, ALL_GROUP_KEY)).toHaveLength(3);
    expect(filterByGroup(items, null, (i) => i.system, ALL_GROUP_KEY)).toHaveLength(3);
  });

  it("returns exactly the named group's items", () => {
    expect(filterByGroup(items, "Cardiovascular Risk", (i) => i.system, ALL_GROUP_KEY).map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("returns NOTHING for a group with no items — never another group's", () => {
    // This is the whole point. The old ternary fell back to items[0]'s group here.
    expect(filterByGroup(items, "Hepatic", (i) => i.system, ALL_GROUP_KEY)).toEqual([]);
  });

  it("returns nothing for an unrecognised group rather than guessing", () => {
    expect(filterByGroup(items, "not-a-system", (i) => i.system, ALL_GROUP_KEY)).toEqual([]);
  });

  it("handles items with no group at all", () => {
    const mixed = [...items, { id: "d", system: undefined as unknown as string }];
    expect(filterByGroup(mixed, "Cardiovascular Risk", (i) => i.system, ALL_GROUP_KEY).map((i) => i.id)).toEqual(["a", "c"]);
  });
});

// W62 P8 — the same rule one level up: WHICH group renders, before which items it shows. Markers
// was the last section resolving this by hand, and its ladder fell through an empty-but-real row.
describe("resolveGroup", () => {
  const keys = ["ungrouped", "ratios", "level:Renal"];

  it("honours a selected row that happens to be empty", () => {
    // The Ratios row is emitted at count 0, so this is the live case, not a hypothetical: the old
    // ladder returned "ungrouped" here and rendered every marker under a row asking for ratios.
    expect(resolveGroup("ratios", keys, () => "ungrouped")).toBe("ratios");
  });

  it("falls back only when the key names no row at all", () => {
    expect(resolveGroup("level:Gone", keys, () => "ungrouped")).toBe("ungrouped");
    expect(resolveGroup(null, keys, () => "ungrouped")).toBe("ungrouped");
    expect(resolveGroup("topic:FromAnotherSection", keys, () => "ungrouped")).toBe("ungrouped");
  });

  it("passes a real key straight through", () => {
    expect(resolveGroup("level:Renal", keys, () => "ungrouped")).toBe("level:Renal");
  });
});

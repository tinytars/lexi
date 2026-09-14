import { describe, it, expect } from "vitest";
import { filterByLeaf } from "@tinytars/frame/group-filter";

// W62 — the child-row twin of filterByGroup. Notes > Markers and Analysis list their CELLS as child
// rows, so clicking one must narrow the page; before this they only scrolled and the click read as
// ignored — the same complaint that produced filterByGroup one level up.
const items = [{ k: "a" }, { k: "b" }, { k: "c" }];
const keyOf = (i: { k: string }) => i.k;

describe("filterByLeaf", () => {
  it("shows everything when no child is selected", () => {
    expect(filterByLeaf(items, null, keyOf)).toEqual(items);
    expect(filterByLeaf(items, undefined, keyOf)).toEqual(items);
  });

  it("narrows to exactly the selected child", () => {
    expect(filterByLeaf(items, "b", keyOf)).toEqual([{ k: "b" }]);
  });

  // A leaf key belonging to another section (selection outlives a section switch, or a section that
  // does not filter by leaf) must not blank the page.
  it("falls back to everything when the key matches nothing here", () => {
    expect(filterByLeaf(items, "not-mine", keyOf)).toEqual(items);
  });

  it("is empty-safe", () => {
    expect(filterByLeaf([], "a", keyOf)).toEqual([]);
  });
});

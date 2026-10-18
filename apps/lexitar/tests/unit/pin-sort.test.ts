import { describe, it, expect } from "vitest";
import { sortPinnedFirst } from "../../src/lib/pin-sort";

describe("sortPinnedFirst", () => {
  it("moves pinned items before unpinned ones, preserving relative order within each group", () => {
    const items = [
      { id: "a", pinned: false },
      { id: "b", pinned: true },
      { id: "c", pinned: false },
      { id: "d", pinned: true },
    ];
    expect(sortPinnedFirst(items).map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("treats an undefined pinned flag as unpinned", () => {
    const items = [{ id: "a" }, { id: "b", pinned: true }];
    expect(sortPinnedFirst(items).map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("returns an empty array unchanged", () => {
    expect(sortPinnedFirst([])).toEqual([]);
  });

  it("accepts a custom getPinned accessor", () => {
    const items = [{ id: "a", favorite: false }, { id: "b", favorite: true }];
    expect(sortPinnedFirst(items, (i) => i.favorite).map((i) => i.id)).toEqual(["b", "a"]);
  });
});

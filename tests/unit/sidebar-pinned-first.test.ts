import { describe, it, expect } from "vitest";
import { sortPinnedFirst } from "../../src/lib/pin-sort";
import { threadLeaf, treatmentLeaf, medicineNameLeaf, ideaLeaf, markerLevelLeaf } from "../../src/lib/sidebar-leaf-mappers";
import { treatmentSidebarBuckets } from "../../src/lib/treatment-sidebar";
import type { Client, TreatmentItem } from "../../src/lib/types";
import type { Thread } from "../../src/lib/chat-threads";

// The three files this covers had NO unit tests before the sidebar unification, which is how
// `pinned` came to be dropped by every mapper while the row type carried the field.

describe("sortPinnedFirst", () => {
  it("floats pinned items and is stable within each group", () => {
    const rows = [
      { key: "a", pinned: false }, { key: "b", pinned: true },
      { key: "c" }, { key: "d", pinned: true },
    ];
    expect(sortPinnedFirst(rows).map((r) => r.key)).toEqual(["b", "d", "a", "c"]);
  });

  it("leaves an all-unpinned list in its original order", () => {
    const rows = [{ key: "a" }, { key: "b" }, { key: "c" }];
    expect(sortPinnedFirst(rows).map((r) => r.key)).toEqual(["a", "b", "c"]);
  });
});

describe("sidebar leaf mappers carry `pinned`", () => {
  it("threadLeaf carries the pin and owns its own DOM id (the row exists only in the sidebar)", () => {
    const t = { id: "t1", title: "Echo question", pinned: true, turns: [], lastActivityAt: 1 } as unknown as Thread;
    const row = threadLeaf(t);
    expect(row).toMatchObject({ key: "t1", label: "Echo question", pinned: true });
    expect(row.domId).toBe(row.anchor);
  });

  it("treatmentLeaf carries the pin", () => {
    const t = { id: "rx1", name: "Ezetimibe", pinned: true } as TreatmentItem;
    expect(treatmentLeaf(t).pinned).toBe(true);
  });

  it("medicineNameLeaf pins the drug when ANY of its dose rows is pinned", () => {
    expect(medicineNameLeaf({ name: "Tirzepatide", rows: [{ pinned: false }, { pinned: true }] }).pinned).toBe(true);
    expect(medicineNameLeaf({ name: "Tirzepatide", rows: [{ pinned: false }] }).pinned).toBe(false);
  });

  it("ideaLeaf keeps the ORIGINAL index in its anchor, since sorting happens on the mapped rows", () => {
    const row = ideaLeaf("Lipids", "patient", 3, "Try ezetimibe", { pinned: true, itemId: "d1" });
    expect(row.pinned).toBe(true);
    expect(row.anchor).toContain("3");
    // The pin has to address the DecisionEntry, not the positional row key — that mismatch is why
    // pinning a hypothesis idea silently did nothing.
    expect(row.itemId).toBe("d1");
    expect(row.key).not.toBe(row.itemId);
    // An AI-proposed idea has no record at all, so it can never be pinned.
    expect(ideaLeaf("Lipids", "ai", 0, "Rosuvastatin", { itemId: null }).itemId).toBeNull();
  });

  it("markerLevelLeaf has no pin yet — Markers has no per-item record", () => {
    expect(markerLevelLeaf({ name: "ApoB" } as never).pinned).toBeUndefined();
  });
});

describe("treatmentSidebarBuckets", () => {
  const rx = (id: string, name: string, start: string, pinned?: boolean): TreatmentItem =>
    ({ id, name, start, pinned }) as TreatmentItem;

  it("returns every bucket's children pinned-first", () => {
    const client = {
      displayName: "T", dob: "1980-01-01", gender: "male", watchlist: [], results: [],
      factors: { treatments: [rx("1", "Aspirin", "2020-01-01"), rx("2", "Ezetimibe", "2020-01-01", true)] },
    } as unknown as Client;
    const buckets = treatmentSidebarBuckets(client, "2026-08-20");
    // The fixture must actually exercise the ordering, or this test proves nothing.
    const mixed = buckets.filter((b) => {
      const pins = (b.children ?? []).map((c) => !!c.pinned);
      return pins.includes(true) && pins.includes(false);
    });
    expect(mixed.length).toBeGreaterThan(0);

    for (const bucket of buckets) {
      const pins = (bucket.children ?? []).map((c) => !!c.pinned);
      const lastPinned = pins.lastIndexOf(true);
      const firstUnpinned = pins.indexOf(false);
      if (lastPinned !== -1 && firstUnpinned !== -1) expect(lastPinned).toBeLessThan(firstUnpinned);
    }
  });
});

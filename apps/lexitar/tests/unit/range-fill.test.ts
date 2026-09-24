import { describe, it, expect } from "vitest";
import type { Client } from "../../src/lib/types";
import { fillMissingRanges, RANGE_FILL_CONCURRENCY } from "../../src/lib/range-fill";

const clientWith = (markers: string[]): Client =>
  ({
    displayName: "P",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: markers.map((marker) => ({ marker, group: "g", source: "Blood", date: "2026-01-01", value: 1, unit: "mg/dL" })),
  }) as unknown as Client;

/** A fill that never resolves on its own, so the test decides when each marker finishes. */
function deferredFill() {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const fill = (marker: string) =>
    new Promise<void>((resolve) => {
      started.push(marker);
      release.set(marker, resolve);
    });
  return { started, fill, finish: (marker: string) => release.get(marker)!() };
}

describe("fillMissingRanges", () => {
  // Every range call sends the same corpus prefix, and a cache entry is not readable until the first
  // response begins. Four simultaneous first calls write four copies of the same reports.
  it("runs the first marker alone, and starts the rest only once it finishes", async () => {
    const { started, fill, finish } = deferredFill();

    const done = fillMissingRanges(clientWith(["a", "b", "c", "d", "e", "f"]), fill);
    await Promise.resolve();
    expect(started).toEqual(["a"]);

    finish("a");
    await Promise.resolve();
    await Promise.resolve();
    expect(started.slice(1)).toEqual(["b", "c", "d", "e"]);

    for (const m of ["b", "c", "d", "e", "f"]) {
      finish(m);
      await Promise.resolve();
    }
    await done;
    expect(started).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("fans the rest out no wider than the concurrency limit", async () => {
    const { started, fill, finish } = deferredFill();
    const markers = Array.from({ length: 12 }, (_, i) => `m${i}`);

    const done = fillMissingRanges(clientWith(markers), fill);
    await Promise.resolve();
    finish("m0");
    await Promise.resolve();
    await Promise.resolve();

    expect(started.length - 1).toBe(RANGE_FILL_CONCURRENCY);

    for (const m of markers) {
      finish(m);
      await Promise.resolve();
    }
    await done;
  });

  it("calls nothing when every marker already has a range", async () => {
    const { started, fill } = deferredFill();
    const client = { ...clientWith(["a"]), personalizedRanges: { a: {} } } as unknown as Client;

    await fillMissingRanges(client, fill);

    expect(started).toEqual([]);
  });
});

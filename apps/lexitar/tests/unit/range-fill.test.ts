import { describe, it, expect } from "vitest";
import type { Client } from "../../src/lib/types";
import { fillMissingRanges } from "../../src/lib/range-fill";

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
  // Two of these at once is two copies of the same report corpus live in one Function isolate,
  // which is what the server's budget now refuses (CORPUS.md) — and a refusal here is a marker
  // silently left without a range. Serial also keeps the prompt cache readable: an entry cannot be
  // read until the first response begins, so simultaneous calls each write their own copy.
  it("runs one marker at a time", async () => {
    const { started, fill, finish } = deferredFill();
    const markers = ["a", "b", "c", "d", "e", "f"];

    const done = fillMissingRanges(clientWith(markers), fill);
    await Promise.resolve();
    expect(started).toEqual(["a"]);

    for (const [i, marker] of markers.entries()) {
      finish(marker);
      await Promise.resolve();
      await Promise.resolve();
      expect(started).toEqual(markers.slice(0, i + 2));
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

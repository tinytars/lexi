import { describe, it, expect } from "vitest";
import { partitionByBucket } from "../../src/lib/treatment-sidebar";
import type { TreatmentItem } from "../../src/lib/types";

function row(start: string, end?: string): Pick<TreatmentItem, "start" | "end"> {
  return { start, end };
}

describe("partitionByBucket", () => {
  const today = "2026-06-01";

  it("splits items into ongoing/planned/past by bucketOf", () => {
    const items = [row("2026-01-01"), row("2026-01-01", "2026-02-01"), row("2026-12-01")];
    const out = partitionByBucket(items, today);
    expect(out.ongoing).toEqual([items[0]]);
    expect(out.past).toEqual([items[1]]);
    expect(out.planned).toEqual([items[2]]);
  });

  it("returns empty arrays for every bucket given no items", () => {
    expect(partitionByBucket([], today)).toEqual({ ongoing: [], planned: [], past: [] });
  });

  it("preserves each bucket's relative order for multiple items in the same bucket", () => {
    const items = [row("2026-01-01"), row("2026-02-01"), row("2026-03-01")];
    expect(partitionByBucket(items, today).ongoing).toEqual(items);
  });
});

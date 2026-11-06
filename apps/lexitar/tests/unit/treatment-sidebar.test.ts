import { describe, it, expect } from "vitest";
import { partitionByBucket, groupBucket, partitionGroupsByBucket } from "../../src/lib/treatment-sidebar";
import { bucketOf, collapseByName } from "@pablotech/akesi/treatment-bucket";
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

describe("groupBucket", () => {
  const today = "2026-06-01";

  it("ongoing beats everything — a titrated drug mid-course is ongoing", () => {
    // The whole defect in one case: an ended step, a current step and a scheduled increase.
    const rows = [row("2025-01-01", "2025-06-01"), row("2025-06-01"), row("2026-09-01")];
    expect(groupBucket(rows, today)).toBe("ongoing");
  });

  it("planned beats past — stopped once, scheduled to resume", () => {
    expect(groupBucket([row("2020-01-01", "2020-06-01"), row("2027-01-01")], today)).toBe("planned");
  });

  it("past only when no row is current and none is scheduled", () => {
    expect(groupBucket([row("2020-01-01", "2020-06-01"), row("2021-01-01", "2021-06-01")], today)).toBe("past");
  });

  it("agrees with bucketOf for a single-row group, in all three buckets", () => {
    expect(groupBucket([row("2026-01-01")], today)).toBe("ongoing");
    expect(groupBucket([row("2026-12-01")], today)).toBe("planned");
    expect(groupBucket([row("2026-01-01", "2026-02-01")], today)).toBe("past");
  });

  it("is order-independent — the fold reads every row, not the first", () => {
    const ended = row("2020-01-01", "2020-06-01");
    const current = row("2025-01-01");
    expect(groupBucket([ended, current], today)).toBe("ongoing");
    expect(groupBucket([current, ended], today)).toBe("ongoing");
  });

  it("disagrees with groupByName's newest-start sort rule on exactly one shape", () => {
    // Open-ended current row plus a later planned row. GROUP_BUCKET_ORDER reads rows[0] — the
    // newest START, i.e. the planned one — and calls the drug planned. You are taking it.
    const rows = [row("2026-09-01"), row("2025-01-01")];
    expect(bucketOf(rows[0], today)).toBe("planned");
    expect(groupBucket(rows, today)).toBe("ongoing");
  });

  it("disagrees with collapseByName in both directions", () => {
    // Morning row left open, evening row closed out: the collapsed representative is finished.
    const openAndClosed: TreatmentItem[] = [
      { id: "a", name: "Pregnenolone", start: "2020-01-01" },
      { id: "b", name: "Pregnenolone", start: "2021-01-01", end: "2021-06-01" },
    ];
    expect(bucketOf(collapseByName(openAndClosed)[0], today)).toBe("past");
    expect(groupBucket(openAndClosed, today)).toBe("ongoing");

    // Took it years ago, plan to resume: the collapsed representative looks open-ended.
    const stoppedAndScheduled: TreatmentItem[] = [
      { id: "c", name: "Tirzepatide", start: "2020-01-01", end: "2020-06-01" },
      { id: "d", name: "Tirzepatide", start: "2027-01-01" },
    ];
    expect(bucketOf(collapseByName(stoppedAndScheduled)[0], today)).toBe("ongoing");
    expect(groupBucket(stoppedAndScheduled, today)).toBe("planned");
  });

  it("no rows is past, vacuously", () => {
    expect(groupBucket([], today)).toBe("past");
  });
});

describe("partitionGroupsByBucket", () => {
  const today = "2026-06-01";
  const groups = [
    { name: "Pregnenolone", rows: [row("2025-01-01", "2025-06-01"), row("2025-06-01"), row("2026-09-01")] },
    { name: "Tirzepatide", rows: [row("2020-01-01", "2020-06-01"), row("2027-01-01")] },
    { name: "Naltrexone", rows: [row("2020-01-01", "2020-06-01")] },
  ];

  it("places each group in exactly one bucket, with all of its rows", () => {
    const out = partitionGroupsByBucket(groups, today);
    expect(out.ongoing.map((g) => g.name)).toEqual(["Pregnenolone"]);
    expect(out.planned.map((g) => g.name)).toEqual(["Tirzepatide"]);
    expect(out.past.map((g) => g.name)).toEqual(["Naltrexone"]);
    expect(out.ongoing[0].rows).toHaveLength(3);
  });

  it("I1 — the three counts sum to the group count (the partition invariant)", () => {
    const out = partitionGroupsByBucket(groups, today);
    expect(out.ongoing.length + out.planned.length + out.past.length).toBe(groups.length);
  });

  it("I2 — every group in a temporal bucket is the same object, rows and all", () => {
    const out = partitionGroupsByBucket(groups, today);
    for (const g of groups) {
      const found = [...out.ongoing, ...out.planned, ...out.past].filter((x) => x === g);
      expect(found).toHaveLength(1);
      expect(found[0].rows).toBe(g.rows);
    }
  });

  it("returns empty arrays for every bucket given no groups", () => {
    expect(partitionGroupsByBucket([], today)).toEqual({ ongoing: [], planned: [], past: [] });
  });

  it("preserves input order within a bucket", () => {
    const a = { rows: [row("2025-01-01")] };
    const b = { rows: [row("2025-02-01")] };
    expect(partitionGroupsByBucket([a, b], today).ongoing).toEqual([a, b]);
  });
});

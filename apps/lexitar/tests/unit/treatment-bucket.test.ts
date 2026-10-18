import { describe, it, expect } from "vitest";
import { bucketOf, collapseByName, treatmentLabel, treatmentMeta, groupByName, dateGaps, formatDose, matchOngoingAssessment } from "@pablotech/akesi/treatment-bucket";
import { treatmentSidebarBuckets } from "../../src/lib/treatment-sidebar";
import type { Client, TreatmentItem } from "../../src/lib/types";

const T = (start: string, end?: string): Pick<TreatmentItem, "start" | "end"> => ({ start, end });

describe("bucketOf", () => {
  const today = "2026-07";

  it("no end, past start → ongoing", () => {
    expect(bucketOf(T("2025-01"), today)).toBe("ongoing");
  });
  it("empty start → ongoing (taking it, date unknown)", () => {
    expect(bucketOf(T(""), today)).toBe("ongoing");
  });
  it("future start → planned", () => {
    expect(bucketOf(T("2026-09"), today)).toBe("planned");
  });
  it("ended in the past → past", () => {
    expect(bucketOf(T("2024-01", "2025-06"), today)).toBe("past");
  });
  it("end == today → still ongoing (boundary)", () => {
    expect(bucketOf(T("2025-01", "2026-07"), today)).toBe("ongoing");
  });
  it("start == today → ongoing (boundary, not planned)", () => {
    expect(bucketOf(T("2026-07"), today)).toBe("ongoing");
  });
  it("future end on a started treatment → ongoing", () => {
    expect(bucketOf(T("2025-01", "2027-01"), today)).toBe("ongoing");
  });
  it("year-only dates compare by common prefix", () => {
    expect(bucketOf(T("2028"), today)).toBe("planned");
    expect(bucketOf(T("2010"), today)).toBe("ongoing");
  });
});

describe("bucketOf — day precision", () => {
  const today = "2026-08-16";

  it("ended yesterday → past, not ongoing (regression: was masked by month-only comparison)", () => {
    expect(bucketOf(T("2026-01-01", "2026-08-15"), today)).toBe("past");
  });
  it("ends today → still ongoing (boundary)", () => {
    expect(bucketOf(T("2026-01-01", "2026-08-16"), today)).toBe("ongoing");
  });
  it("ends later this month → still ongoing", () => {
    expect(bucketOf(T("2026-01-01", "2026-08-20"), today)).toBe("ongoing");
  });
  it("starts tomorrow → planned, even within the same month", () => {
    expect(bucketOf(T("2026-08-17"), today)).toBe("planned");
  });
  it("a day-precision today against a legacy month-only end still degrades to month-level", () => {
    expect(bucketOf(T("2026-01", "2026-08"), today)).toBe("ongoing");
  });
});

describe("collapseByName", () => {
  it("collapses titration rows to earliest start + latest dose, kept ongoing", () => {
    const items: TreatmentItem[] = [
      { id: "t1", name: "DHEA", dose: "10mg", kind: "supplement", start: "2025-01" },
      { id: "t2", name: "DHEA", dose: "15mg", kind: "supplement", start: "2025-06" },
    ];
    const [c] = collapseByName(items);
    // The collapsed row carries the LATEST row's id along with its dose — earliest start, latest
    // everything else, which is what makes the medicine group's pin and menu address the live row.
    expect(c).toEqual({ id: "t2", name: "DHEA", dose: "15mg", kind: "supplement", start: "2025-01" });
  });

  it("marks a collapsed treatment past only when the latest row is ended", () => {
    const items: TreatmentItem[] = [
      { id: "m1", name: "Metformin", dose: "500mg", kind: "drug", start: "2023-01", end: "2024-01" },
      { id: "m2", name: "Metformin", dose: "1000mg", kind: "drug", start: "2024-01", end: "2024-12" },
    ];
    const [c] = collapseByName(items);
    expect(c.start).toBe("2023-01");
    expect(c.end).toBe("2024-12");
  });
});

describe("formatDose", () => {
  it("formats structured amount + unit + frequency as the pre-existing 'AmountUnit/Frequency' convention", () => {
    expect(formatDose({ doseAmount: 6, doseUnit: "mg", doseFrequency: "week" })).toBe("6mg/week");
  });
  it("omits the unit and/or frequency when absent", () => {
    expect(formatDose({ doseAmount: 7.5 })).toBe("7.5");
    expect(formatDose({ doseAmount: 9, doseUnit: "mg" })).toBe("9mg");
  });
  it("falls back to the legacy free-text dose string when not yet migrated", () => {
    expect(formatDose({ dose: "1.5g/day elemental" })).toBe("1.5g/day elemental");
  });
  it("prefers structured fields over a stale legacy dose string, if somehow both are set", () => {
    expect(formatDose({ dose: "old value", doseAmount: 10, doseUnit: "mg" })).toBe("10mg");
  });
  it("is undefined for a doseless behavior", () => {
    expect(formatDose({})).toBeUndefined();
  });
});

describe("treatmentLabel", () => {
  it("is name + dose when a dose is present", () => {
    expect(treatmentLabel({ name: "Rosuvastatin", dose: "20mg" })).toBe("Rosuvastatin 20mg");
  });
  it("is name + structured dose when doseAmount is present", () => {
    expect(treatmentLabel({ name: "Rosuvastatin", doseAmount: 20, doseUnit: "mg" })).toBe("Rosuvastatin 20mg");
  });
  it("is just the name for a doseless behavior", () => {
    expect(treatmentLabel({ name: "10k steps/day" })).toBe("10k steps/day");
  });
});

describe("matchOngoingAssessment", () => {
  const assessments = [
    { item: "Magnesium glycinate 1.5g/day elemental", assessment: "a" },
    { item: "Rosuvastatin 20 mg", assessment: "b" },
  ];
  it("matches on a full-name substring, case-insensitively", () => {
    expect(matchOngoingAssessment(assessments, "Magnesium Glycinate")?.assessment).toBe("a");
  });
  it("falls back to matching just the first word when the full name doesn't match", () => {
    // dose-annotated item drops the raw treatment's bare "Rosuvastatin" name inside "20 mg"
    expect(matchOngoingAssessment(assessments, "Rosuvastatin")?.assessment).toBe("b");
  });
  it("returns undefined when nothing matches", () => {
    expect(matchOngoingAssessment(assessments, "Coq10")).toBeUndefined();
  });
  it("returns undefined for a blank name", () => {
    expect(matchOngoingAssessment(assessments, "  ")).toBeUndefined();
  });
});

describe("treatmentMeta", () => {
  it("renders a clear day-bearing range for past treatments (legacy month-only → last day)", () => {
    expect(treatmentMeta(T("2026-04", "2026-05"), "past")).toBe("Apr 30, 2026 – May 31, 2026");
  });
  it("falls back to 'until' when a past treatment has no start", () => {
    expect(treatmentMeta(T("", "2026-05"), "past")).toBe("until May 31, 2026");
  });
  it("phrases ongoing and planned with a full date", () => {
    expect(treatmentMeta(T("2026-04"), "ongoing")).toBe("since Apr 30, 2026");
    expect(treatmentMeta(T("2026-08"), "planned")).toBe("planned for Aug 31, 2026");
  });
  it("omits the date when start is absent", () => {
    expect(treatmentMeta(T(""), "ongoing")).toBeUndefined();
    expect(treatmentMeta(T(""), "planned")).toBe("planned");
  });
});

describe("treatmentSidebarBuckets", () => {
  const today = "2026-07";

  it("emits Ongoing/Planned/Past in that order, with correct counts", () => {
    const client = {
      factors: {
        treatments: [
          { id: "1", name: "Tirzepatide", kind: "drug", start: "2025-01" },
          { id: "2", name: "Rosuvastatin", kind: "drug", start: "2025-06" },
          { id: "3", name: "10k steps/day", kind: "behavior", start: "2026-09" },
          { id: "4", name: "Metformin", kind: "drug", start: "2023-01", end: "2024-01" },
        ],
      },
    } as unknown as Client;
    const rows = treatmentSidebarBuckets(client, today);
    for (const r of rows) expect(r.children).toHaveLength(r.count);
    // Uncollapsed, so Ongoing/Planned/Past children keep the raw array's insertion order
    // (matches editModel, which doesn't sort by name either) rather than collapseByName's
    // alphabetical sort. All is the one exception (M108/M109): grouped by name, ordered
    // Planned/Ongoing/Past by each drug's own bucket, alphabetical within a bucket.
    expect(rows.map((r) => r.children!.map((c) => c.label))).toEqual([
      ["10k steps/day", "Rosuvastatin", "Tirzepatide", "Metformin"],
      ["Tirzepatide", "Rosuvastatin"],
      ["10k steps/day"],
      ["Metformin"],
    ]);
    expect(rows.map(({ children: _children, ...rest }) => rest)).toEqual([
      { key: "medicine", label: "All", count: 4, title: "Full dose/timeframe history per drug." },
      { key: "ongoing", label: "Ongoing", count: 2, title: "Currently being taken." },
      {
        key: "planned",
        label: "Planned",
        count: 1,
        title: "Not started yet — a future start date.",
      },
      {
        key: "past",
        label: "Past",
        count: 1,
        title: "Discontinued — kept for history, still commented on for context.",
      },
    ]);
  });

  it("still yields 4 rows, all count 0, for an empty client", () => {
    const client = { factors: {} } as unknown as Client;
    const rows = treatmentSidebarBuckets(client, today);
    expect(rows).toEqual([
      { key: "medicine", label: "All", count: 0, title: "Full dose/timeframe history per drug.", children: [] },
      { key: "ongoing", label: "Ongoing", count: 0, title: "Currently being taken.", children: [] },
      {
        key: "planned",
        label: "Planned",
        count: 0,
        title: "Not started yet — a future start date.",
        children: [],
      },
      {
        key: "past",
        label: "Past",
        count: 0,
        title: "Discontinued — kept for history, still commented on for context.",
        children: [],
      },
    ]);
  });

  it("All groups by distinct name, one leaf each, regardless of titration step count", () => {
    const client = {
      factors: {
        treatments: [
          { id: "1", name: "Glycine", kind: "supplement", start: "2025-11-30", end: "2026-03-31" },
          { id: "2", name: "Glycine", kind: "supplement", start: "2026-04-30" },
          { id: "3", name: "Micronized DHEA", kind: "supplement", start: "2026-04-30", end: "2026-05-31" },
        ],
      },
    } as unknown as Client;
    const rows = treatmentSidebarBuckets(client, "2026-08-16");
    const medicine = rows.find((r) => r.key === "medicine")!;
    expect(medicine.count).toBe(2);
    expect(medicine.children!.map((c) => c.label)).toEqual(["Glycine", "Micronized DHEA"]);
  });

  it("counts each titration step in its own bucket, uncollapsed (regression: collapsing by name masked a superseded past step behind a still-open one)", () => {
    const client = {
      factors: {
        treatments: [
          // Superseded step: ended, but the drug's latest step (below) is still open — a collapsed
          // representative would read this whole drug as "ongoing" and hide this step from Past.
          { id: "1", name: "Glycine", kind: "supplement", start: "2025-11-30", end: "2026-03-31" },
          { id: "2", name: "Glycine", kind: "supplement", start: "2026-04-30" },
          // A drug with no open step at all — every step is individually past.
          { id: "3", name: "Micronized DHEA", kind: "supplement", start: "2026-04-30", end: "2026-05-31" },
        ],
      },
    } as unknown as Client;
    const rows = treatmentSidebarBuckets(client, "2026-08-16");
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.ongoing.count).toBe(1);
    expect(byKey.ongoing.children!.map((c) => c.key)).toEqual(["2"]);
    expect(byKey.past.count).toBe(2);
    expect(byKey.past.children!.map((c) => c.key)).toEqual(["1", "3"]);
  });
});

describe("groupByName", () => {
  const today = "2026-08-16";

  it("groups by name (case/whitespace-insensitively) and sorts each group's rows newest-first (M105)", () => {
    const items: TreatmentItem[] = [
      { id: "1", name: "Glycine", start: "2026-04-30", end: "2026-06-30" } as TreatmentItem,
      { id: "2", name: " glycine ", start: "2025-11-30", end: "2026-03-31" } as TreatmentItem,
      { id: "3", name: "Glycine", start: "2026-07-01", end: "2026-08-15" } as TreatmentItem,
      { id: "4", name: "Micronized DHEA", start: "2026-04-30", end: "2026-05-31" } as TreatmentItem,
    ];
    const groups = groupByName(items, today);
    expect(groups.map((g) => g.name)).toEqual(["Glycine", "Micronized DHEA"]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["3", "1", "2"]);
  });

  it("ties within the same bucket sort alphabetically, not entry order (M109)", () => {
    const items: TreatmentItem[] = [
      { id: "1", name: "B-drug", start: "2026-01" } as TreatmentItem,
      { id: "2", name: "A-drug", start: "2026-01" } as TreatmentItem,
    ];
    // Both read "ongoing" (a month-only start well before `today`, no end) — same bucket, so
    // group order falls back to alphabetical.
    expect(groupByName(items, today).map((g) => g.name)).toEqual(["A-drug", "B-drug"]);
  });

  it("orders groups Planned, then Ongoing, then Past — by each drug's NEWEST row, not entry order or name (M108)", () => {
    const items: TreatmentItem[] = [
      { id: "1", name: "Past-drug", start: "2026-01-01", end: "2026-02-01" } as TreatmentItem,
      { id: "2", name: "Planned-drug", start: "2026-09-01" } as TreatmentItem,
      { id: "3", name: "Ongoing-drug", start: "2026-01-01" } as TreatmentItem,
    ];
    expect(groupByName(items, today).map((g) => g.name)).toEqual(["Planned-drug", "Ongoing-drug", "Past-drug"]);
  });

  it("a drug's bucket for ordering purposes is its newest row's, even if an older row of the same drug reads differently", () => {
    const items: TreatmentItem[] = [
      // Superseded, past-dated step, but the drug's LATEST step (below) is still open — the whole
      // group must sort as Ongoing, not Past.
      { id: "1", name: "Glycine", start: "2025-01-01", end: "2025-06-01" } as TreatmentItem,
      { id: "2", name: "Glycine", start: "2026-04-30" } as TreatmentItem,
      { id: "3", name: "Ezetimibe", start: "2026-09-01" } as TreatmentItem,
    ];
    expect(groupByName(items, today).map((g) => g.name)).toEqual(["Ezetimibe", "Glycine"]);
  });
});

// M105 — dateGaps() now takes rows newest-first (matching groupByName's display order), so every
// fixture below lists the LATER entry first and the EARLIER entry second.
describe("dateGaps", () => {
  it("is empty for zero or one row (nothing to compare)", () => {
    expect(dateGaps([])).toEqual([]);
    expect(dateGaps([{ start: "2026-01" } as TreatmentItem])).toEqual([]);
  });

  it("flags a gap when the newer entry starts after the older one ends", () => {
    const rows = [
      { start: "2026-04-30" } as TreatmentItem,
      { start: "2025-11-30", end: "2026-03-31" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["gap"]);
  });

  it("flags an overlap when the newer entry starts before the older one ends", () => {
    const rows = [
      { start: "2026-05-01" } as TreatmentItem,
      { start: "2026-01-01", end: "2026-06-01" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["overlap"]);
  });

  it("is ok for a same-day handoff (older end == newer start)", () => {
    const rows = [
      { start: "2026-06-01" } as TreatmentItem,
      { start: "2026-01-01", end: "2026-06-01" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["ok"]);
  });

  it("is ok, not a false gap, when the older row is still ongoing (no end) or the newer start is unknown", () => {
    const stillOpen = [
      { start: "2026-06-01" } as TreatmentItem,
      { start: "2026-01-01" } as TreatmentItem,
    ];
    const unknownNewerStart = [
      { start: "" } as TreatmentItem,
      { start: "2026-01-01", end: "2026-06-01" } as TreatmentItem,
    ];
    expect(dateGaps(stillOpen)).toEqual(["ok"]);
    expect(dateGaps(unknownNewerStart)).toEqual(["ok"]);
  });

  it("Glycine's real-world shape: a gap before the middle step and another before the newest", () => {
    const rows = [
      { start: "2026-08-01", end: "2026-08-15" } as TreatmentItem,
      { start: "2026-04-30", end: "2026-06-30" } as TreatmentItem,
      { start: "2025-11-30", end: "2026-03-31" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["gap", "gap"]);
  });

  it("is ok for a next-day handoff (regression: was flagged 'gap' — end 2026-06-30, next start 2026-07-01 is back-to-back, not a missed day)", () => {
    const rows = [
      { start: "2026-08-01", end: "2026-08-31" } as TreatmentItem,
      { start: "2026-07-01", end: "2026-07-31" } as TreatmentItem,
      { start: "2025-05-15", end: "2026-06-30" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["ok", "ok"]);
  });

  it("still flags a real multi-day gap even at day precision", () => {
    const rows = [
      { start: "2026-02-05" } as TreatmentItem,
      { start: "2026-01-01", end: "2026-01-31" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["gap"]);
  });

  it("still flags a real overlap at day precision (newer starts before the older ends)", () => {
    const rows = [
      { start: "2026-06-10" } as TreatmentItem,
      { start: "2026-01-01", end: "2026-06-15" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["overlap"]);
  });

  it("is ok for a 1-day overlap (M106 — as forgiving on the overlap side as the gap side)", () => {
    const rows = [
      { start: "2026-06-14" } as TreatmentItem,
      { start: "2026-01-01", end: "2026-06-15" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["ok"]);
  });

  it("still flags a 2-day overlap (the leniency is exactly 1 day, not more)", () => {
    const rows = [
      { start: "2026-06-13" } as TreatmentItem,
      { start: "2026-01-01", end: "2026-06-15" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["overlap"]);
  });

  it("is ok for identical dates split AM/PM — a twice-daily dose, not double-dosing (M110)", () => {
    const rows = [
      { start: "2026-07-01", end: "2026-07-31", timingPeriod: "PM" } as TreatmentItem,
      { start: "2026-07-01", end: "2026-07-31", timingPeriod: "AM" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["ok"]);
  });

  it("still flags an overlap when timing is the same (both AM) or unset on either side (M110)", () => {
    const sameTiming = [
      { start: "2026-07-01", end: "2026-07-31", timingPeriod: "AM" } as TreatmentItem,
      { start: "2026-06-01", end: "2026-07-15", timingPeriod: "AM" } as TreatmentItem,
    ];
    const oneUnset = [
      { start: "2026-07-01", end: "2026-07-31", timingPeriod: "AM" } as TreatmentItem,
      { start: "2026-06-01", end: "2026-07-15" } as TreatmentItem,
    ];
    expect(dateGaps(sameTiming)).toEqual(["overlap"]);
    expect(dateGaps(oneUnset)).toEqual(["overlap"]);
  });

  it("an AM/PM split doesn't mask a genuine gap — timing only downgrades an overlap, not a gap", () => {
    const rows = [
      { start: "2026-08-01", timingPeriod: "PM" } as TreatmentItem,
      { start: "2026-01-01", end: "2026-01-31", timingPeriod: "AM" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["gap"]);
  });

  it("real-world shape: an old long-spanning row genuinely overlaps a later, more granular titration step (not a false positive)", () => {
    // Reported case: a Feb–Mar 2026 step sits entirely inside a May 2025–Jun 2026 row directly
    // below it (descending order) — a real ~134-day overlap, correctly flagged either way.
    const rows = [
      { start: "2026-02-16", end: "2026-03-15" } as TreatmentItem,
      { start: "2025-05-16", end: "2026-06-30" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["overlap"]);
  });

  it("falls back to prefix comparison (no next-day leniency) for month-only precision", () => {
    const rows = [
      { start: "2026-04" } as TreatmentItem,
      { start: "2025-11", end: "2026-03" } as TreatmentItem,
    ];
    expect(dateGaps(rows)).toEqual(["gap"]);
  });
});

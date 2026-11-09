import { describe, it, expect } from "vitest";
import { buildTreatmentRows } from "../../src/lib/TreatmentRow.svelte";
import { buildChatContext } from "../../src/lib/chat-context";
import { treatmentSearchLeaves } from "../../src/lib/search-index";
import type { Client, TreatmentItem } from "../../src/lib/types";

// These four surfaces read the clock (todayISODate), so every fixture date is far enough from any
// plausible run date to stay on the same side of it: 2020 is over, 2099 has not begun.
function client(treatments: TreatmentItem[]): Client {
  return { watchlist: [], results: [], factors: { treatments } } as unknown as Client;
}

// The two shapes where the collapsed representative and the drug's own history disagree. Both are
// real records rather than constructed edge cases: collapseByName takes the EARLIEST start and
// carries an end only when the newest-start row has one, so it cannot express "a current dose
// period AND a future one", which is the state every titrated drug is in.
const MORNING_OPEN_EVENING_CLOSED: TreatmentItem[] = [
  // The morning dose, never closed out — the drug is being taken.
  { id: "m", name: "Pregnenolone", kind: "supplement", dose: "25mg", start: "2020-01-01" },
  // The evening dose, discontinued. It is the newest START, so the collapsed item takes its end.
  { id: "e", name: "Pregnenolone", kind: "supplement", dose: "50mg", start: "2021-01-01", end: "2021-06-01" },
];
const USED_TO_TAKE_PLAN_TO_RESUME: TreatmentItem[] = [
  { id: "o", name: "Tirzepatide", kind: "drug", dose: "2.5mg", start: "2020-01-01", end: "2020-06-01" },
  // The newest start, with no end — which is why the collapsed item reads as open-ended.
  { id: "n", name: "Tirzepatide", kind: "drug", dose: "5mg", start: "2099-01-01" },
];

describe("buildTreatmentRows buckets the drug, not its collapsed representative", () => {
  it("a drug whose morning row is open and evening row closed out is Ongoing, not Past", () => {
    const rows = buildTreatmentRows(client(MORNING_OPEN_EVENING_CLOSED));
    expect(rows.ongoing.map((r) => [r.name, r.bucket])).toEqual([["Pregnenolone", "ongoing"]]);
    expect(rows.past).toEqual([]);
    expect(rows.planned).toEqual([]);
  });

  it("a drug taken years ago and scheduled to resume is Planned, not Ongoing", () => {
    const rows = buildTreatmentRows(client(USED_TO_TAKE_PLAN_TO_RESUME));
    expect(rows.planned.map((r) => [r.name, r.bucket])).toEqual([["Tirzepatide", "planned"]]);
    expect(rows.ongoing).toEqual([]);
    expect(rows.past).toEqual([]);
  });

  // The bucket and the date are two decisions, and getting the first right is what exposes the
  // second: treatmentMeta over the collapsed item would render the drug's earliest start, so a
  // drug correctly filed as Planned announced a start date eighty years in the past.
  it("a planned drug's date is the row it actually resumes on, not its earliest start", () => {
    const [row] = buildTreatmentRows(client(USED_TO_TAKE_PLAN_TO_RESUME)).planned;
    expect(row.meta).toContain("2099");
    expect(row.meta).not.toContain("2020");
  });

  it("still agrees with the row-level bucket for a drug that has only one dose period", () => {
    const rows = buildTreatmentRows(
      client([
        { id: "a", name: "Aspirin", kind: "drug", start: "2020-01-01" },
        { id: "b", name: "Berberine", kind: "supplement", start: "2099-01-01" },
        { id: "c", name: "Creatine", kind: "supplement", start: "2020-01-01", end: "2020-06-01" },
      ]),
    );
    expect(rows.ongoing.map((r) => r.name)).toEqual(["Aspirin"]);
    expect(rows.planned.map((r) => r.name)).toEqual(["Berberine"]);
    expect(rows.past.map((r) => r.name)).toEqual(["Creatine"]);
  });
});

describe("the model's context and the search index read the same bucket", () => {
  it("chat context labels the drug's own bucket", () => {
    const ctx = buildChatContext(client(MORNING_OPEN_EVENING_CLOSED));
    expect(ctx.treatments.map((t) => [t.name, t.bucket])).toEqual([["Pregnenolone", "ongoing"]]);
    expect(buildChatContext(client(USED_TO_TAKE_PLAN_TO_RESUME)).treatments[0].bucket).toBe("planned");
  });

  // The bucket is in `searchText`, so a wrong one is not only displayed: typing "past" matched a
  // drug being taken and typing "ongoing" did not find it.
  it("a search leaf's label and search text carry the drug's own bucket", () => {
    const [leaf] = treatmentSearchLeaves(client(MORNING_OPEN_EVENING_CLOSED));
    expect(leaf.context).toContain("ongoing");
    expect(leaf.searchText).toContain("ongoing");
    expect(leaf.searchText).not.toContain("past");
    expect(treatmentSearchLeaves(client(USED_TO_TAKE_PLAN_TO_RESUME))[0].context).toContain("planned");
  });
});

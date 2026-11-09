import { describe, it, expect } from "vitest";
import {
  resolveTreatmentView,
  editView,
  readView,
  groupBucketForAnchor,
  groupDisplay,
  MEDICINE_PREVIEW_ROWS,
  treatmentModalLabel,
} from "../../src/lib/treatment-view-model";
import { groupByName } from "@pablotech/akesi/treatment-bucket";
import type { Client, TreatmentItem } from "../../src/lib/types";

const TODAY = "2026-06-15";

function row(id: string, name: string, start: string, overrides: Partial<TreatmentItem> = {}): TreatmentItem {
  return { id, name, start, ...overrides };
}
const ROWS: TreatmentItem[] = [
  row("a1", "Aspirin", "2026-01-01"),
  row("a0", "Aspirin", "2025-01-01", { end: "2025-06-01" }),
  row("b1", "Berberine", "2027-01-01"),
  row("c1", "Creatine", "2024-01-01", { end: "2024-06-01", pinned: true }),
];

describe("resolveTreatmentView", () => {
  it("keeps a temporal bucket key", () => {
    expect(["ongoing", "planned", "past"].map(resolveTreatmentView)).toEqual(["ongoing", "planned", "past"]);
  });

  it("falls back to medicine for null, a retired key, or anything foreign", () => {
    expect([null, undefined, "ungrouped", "medicine", "nonsense"].map(resolveTreatmentView)).toEqual(Array(5).fill("medicine"));
  });
});

describe("editView", () => {
  it("medicine: every drug with its full history, pinned first, nothing to badge from the view", () => {
    const v = editView(ROWS, "medicine", TODAY);
    expect(v.groups.map((g) => [g.name, g.rows.length])).toEqual([["Creatine", 1], ["Berberine", 1], ["Aspirin", 2]]);
    expect(v).toMatchObject({ label: "", bucket: null });
  });

  // Reversed 2026-11-06. This asserted that Past holds Aspirin's ended dose period, which is how a
  // drug taken this morning rendered a card under "Discontinued": Past now means the DRUG is
  // finished, and Aspirin's ended period is reachable from the view it does belong to.
  it("a temporal view holds only the drugs that bucket claims, and drops one that is merely a row of theirs", () => {
    const v = editView(ROWS, "past", TODAY);
    expect(v.groups.map((g) => [g.name, g.rows.map((r) => r.id)])).toEqual([["Creatine", ["c1"]]]);
    expect(v).toMatchObject({ label: "past ", bucket: "past" });
  });

  it("a selected drug carries its complete history, not the view's slice of it", () => {
    expect(editView(ROWS, "planned", TODAY).groups.map((g) => g.name)).toEqual(["Berberine"]);
    const ongoing = editView(ROWS, "ongoing", TODAY);
    expect(ongoing.groups.map((g) => g.name)).toEqual(["Aspirin"]);
    expect(ongoing.groups[0].rows.map((r) => r.id)).toEqual(["a1", "a0"]);
  });

  // Invariant I1 at the card level: the three views partition All's membership exactly.
  it("the three temporal views partition the drugs All shows", () => {
    const all = editView(ROWS, "medicine", TODAY).groups.map((g) => g.name).sort();
    const temporal = (["ongoing", "planned", "past"] as const).flatMap((v) => editView(ROWS, v, TODAY).groups.map((g) => g.name));
    expect(temporal.sort()).toEqual(all);
  });

  it("pins the drug when any of its dose periods is pinned, not only the first", () => {
    const rows = [row("z1", "Zinc", "2026-01-01"), row("z0", "Zinc", "2025-01-01", { end: "2025-02-01", pinned: true }), ...ROWS];
    expect(editView(rows, "medicine", TODAY).groups[0].name).toBe("Zinc");
  });
});

describe("groupDisplay", () => {
  // A titrated drug: four dose periods, one of them in the future, one ended long ago.
  const TITRATED: TreatmentItem[] = [
    row("t4", "Tirzepatide", "2027-01-01"),
    row("t3", "Tirzepatide", "2026-05-01"),
    row("t2", "Tirzepatide", "2026-03-01", { end: "2026-04-30" }),
    row("t1", "Tirzepatide", "2026-01-01", { end: "2026-02-28" }),
  ];
  const g = () => groupByName(TITRATED, TODAY)[0];

  it("All opens on the newest few of every row and offers the rest", () => {
    const d = groupDisplay(g(), null, TODAY, false);
    expect(d.rows.map((r) => r.row.id)).toEqual(["t4", "t3", "t2"]);
    expect(d.rows.every((r) => !r.outOfBucket)).toBe(true);
    expect(d).toMatchObject({ showToggle: true, toggleLabel: "⌄ Show all 4" });
  });

  it("a temporal view opens on that bucket's own rows and offers the whole history", () => {
    const d = groupDisplay(g(), "ongoing", TODAY, false);
    expect(d.rows.map((r) => r.row.id)).toEqual(["t3"]);
    expect(d).toMatchObject({ showToggle: true, toggleLabel: "⌄ Show full history (4)" });
  });

  it("expanded shows every row, flagging the ones the view does not claim", () => {
    const d = groupDisplay(g(), "ongoing", TODAY, true);
    expect(d.rows.map((r) => [r.row.id, r.outOfBucket])).toEqual([["t4", true], ["t3", false], ["t2", true], ["t1", true]]);
    expect(d).toMatchObject({ showToggle: true, toggleLabel: "⌃ Show fewer" });
  });

  it("indices are into the drug's full set, so a gap verdict keeps its meaning", () => {
    const collapsed = groupDisplay(g(), "ongoing", TODAY, false);
    expect(collapsed.rows.map((r) => r.i)).toEqual([1]);
    expect(collapsed.gaps).toHaveLength(TITRATED.length - 1);
    // t2 ended 2026-04-30 and t3 started 2026-05-01 — adjacent, so no flag between them.
    expect(collapsed.gaps[1]).toBe("ok");
  });

  it("offers no toggle when the collapsed card already shows everything", () => {
    const one = groupByName([row("s1", "Selenium", "2026-01-01")], TODAY)[0];
    expect(groupDisplay(one, "ongoing", TODAY, false)).toMatchObject({ showToggle: false });
    expect(groupDisplay(one, null, TODAY, false)).toMatchObject({ showToggle: false });
  });

  // The toggle is a property of the collapsed set, not of the row count: two rows is under the
  // preview cap and still hides one, because that one is not in this view.
  it("offers a toggle for a two-row drug when one of the rows is out of bucket", () => {
    const two = groupByName([row("p1", "Pregnenolone", "2026-01-01"), row("p0", "Pregnenolone", "2025-01-01", { end: "2025-02-01" })], TODAY)[0];
    expect(two.rows.length).toBeLessThan(MEDICINE_PREVIEW_ROWS);
    expect(groupDisplay(two, "ongoing", TODAY, false)).toMatchObject({ showToggle: true, toggleLabel: "⌄ Show full history (2)" });
  });
});

describe("readView", () => {
  type ReadRow = { name: string; group?: string };
  const model: Record<"ongoing" | "planned" | "past", ReadRow[]> = {
    ongoing: [{ name: "Aspirin", group: "Cardio" }],
    planned: [{ name: "Berberine", group: "Metabolic" }],
    past: [{ name: "Creatine" }],
  };
  const analysed = { displayName: "P", finding: { disease: [{ group: "Metabolic" }, { group: "Cardio" }] } } as unknown as Client;

  it("medicine concatenates ongoing, planned, past and groups them in system order", () => {
    const v = readView(analysed, model, "medicine");
    expect(v.rows.map((r) => r.name)).toEqual(["Aspirin", "Berberine", "Creatine"]);
    expect(v.grouped!.map((g) => [g.system, g.rows.map((r) => r.name)])).toEqual([
      ["Metabolic", ["Berberine"]], ["Cardio", ["Aspirin"]], ["Not yet categorized", ["Creatine"]],
    ]);
    expect(v.label).toBe("");
  });

  it("a bucket view reads only that bucket, labelled", () => {
    const v = readView(analysed, model, "past");
    expect(v.rows.map((r) => r.name)).toEqual(["Creatine"]);
    expect(v.label).toBe("past ");
  });

  it("is ungrouped until the system analysis exists", () => {
    expect(readView({ displayName: "P" } as Client, model, "ongoing").grouped).toBeNull();
  });
});

describe("groupBucketForAnchor", () => {
  it("resolves a medicine anchor to its drug's bucket", () => {
    expect(groupBucketForAnchor(ROWS, "rx-berberine", TODAY)).toBe("planned");
    expect(groupBucketForAnchor(ROWS, "rx-creatine", TODAY)).toBe("past");
  });

  it("resolves a dose-row anchor (medicine anchor plus suffix)", () => {
    expect(groupBucketForAnchor(ROWS, "rx-berberine-2027-01-01", TODAY)).toBe("planned");
  });

  // The case that sent a save into the wrong view: Aspirin's own ended dose period used to resolve
  // the anchor to past, which is the bucket the collapsed representative reads, and the view then
  // switched to one the drug is not in.
  it("resolves a drug with both an ended and a current dose period to ongoing", () => {
    expect(groupBucketForAnchor(ROWS, "rx-aspirin", TODAY)).toBe("ongoing");
  });

  it("returns undefined for an unknown anchor", () => {
    expect(groupBucketForAnchor(ROWS, "rx-nothing", TODAY)).toBeUndefined();
  });
});

describe("treatmentModalLabel", () => {
  it("names the modal by scope, then by add vs edit", () => {
    expect(treatmentModalLabel("medicine", null)).toBe("Edit medicine");
    expect(treatmentModalLabel("entry", 0)).toBe("Edit dose entry");
    expect(treatmentModalLabel("all", 0)).toBe("Edit treatment");
    expect(treatmentModalLabel("all", null)).toBe("Add treatment");
  });
});

import { describe, it, expect } from "vitest";
import { resolveTreatmentView, editView, readView, bucketForAnchor, treatmentModalLabel } from "../../src/lib/treatment-view-model";
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
  it("medicine: every drug with its full history, pinned first, badged", () => {
    const v = editView(ROWS, "medicine", TODAY);
    expect(v.groups.map((g) => [g.name, g.rows.length])).toEqual([["Creatine", 1], ["Berberine", 1], ["Aspirin", 2]]);
    expect(v).toMatchObject({ label: "", badge: true });
  });

  it("a temporal view groups only the rows its bucket admits, unbadged", () => {
    const v = editView(ROWS, "past", TODAY);
    expect(v.groups.map((g) => [g.name, g.rows.map((r) => r.id)])).toEqual([["Creatine", ["c1"]], ["Aspirin", ["a0"]]]);
    expect(v).toMatchObject({ label: "past ", badge: false });
  });

  it("planned and ongoing views hold their own rows", () => {
    expect(editView(ROWS, "planned", TODAY).groups.map((g) => g.name)).toEqual(["Berberine"]);
    expect(editView(ROWS, "ongoing", TODAY).groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(["a1"]);
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

describe("bucketForAnchor", () => {
  const client = { displayName: "P", factors: { treatments: ROWS } } as Client;

  it("resolves a medicine anchor to its bucket", () => {
    expect(bucketForAnchor(client, "rx-berberine", TODAY)).toBe("planned");
    expect(bucketForAnchor(client, "rx-creatine", TODAY)).toBe("past");
  });

  it("resolves a dose-row anchor (medicine anchor plus suffix)", () => {
    expect(bucketForAnchor(client, "rx-berberine-2027-01-01", TODAY)).toBe("planned");
  });

  it("returns undefined for an unknown anchor", () => {
    expect(bucketForAnchor(client, "rx-nothing", TODAY)).toBeUndefined();
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

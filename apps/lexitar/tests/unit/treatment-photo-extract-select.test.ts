import { describe, it, expect } from "vitest";
import { selectTreatmentRows } from "../../scripts/treatment-photo-extract";
import type { TreatmentItem } from "../../src/lib/types";

const t = (over: Partial<TreatmentItem>) =>
  ({ id: "t1", name: "Thyroid Support", start: "2026-01-01", ...over } as TreatmentItem);

describe("selectTreatmentRows", () => {
  it("matches every row sharing the name, case/whitespace-insensitively, when no id is given", () => {
    const rows = [
      t({ id: "a", name: " Creahead Creatine " }),
      t({ id: "b", name: "creahead creatine" }),
      t({ id: "c", name: "Something Else" }),
    ];
    expect(selectTreatmentRows(rows, "Creahead Creatine").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("narrows to the one row matching both name and --id", () => {
    const rows = [t({ id: "a", name: "Creahead Creatine" }), t({ id: "b", name: "Creahead Creatine" })];
    expect(selectTreatmentRows(rows, "Creahead Creatine", "b").map((r) => r.id)).toEqual(["b"]);
  });

  it("returns nothing when --id doesn't belong to any name match", () => {
    const rows = [t({ id: "a", name: "Creahead Creatine" }), t({ id: "b", name: "Something Else" })];
    expect(selectTreatmentRows(rows, "Creahead Creatine", "b")).toEqual([]);
  });
});

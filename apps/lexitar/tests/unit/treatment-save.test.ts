import { describe, it, expect } from "vitest";
import { planTreatmentSave, applyTreatmentSave, type TreatmentSaveInput } from "../../src/lib/treatment-save";
import type { Administration, Attachment, Client, TreatmentItem } from "../../src/lib/types";

function row(overrides: Partial<TreatmentItem> = {}): TreatmentItem {
  return { id: "id-1", name: "Metformin", start: "2026-01-01", ...overrides };
}
function admin(unit: string): Administration {
  return { unit, unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" };
}
function att(key: string): Attachment {
  return { key, name: key, mediaType: "image/jpeg", bytes: 1, addedAt: "t" };
}
function input(overrides: Partial<TreatmentSaveInput> = {}): TreatmentSaveInput {
  return { item: row(), scope: "all", editingIndex: null, editGroupName: null, rows: [], ...overrides };
}
function clientWith(treatments: TreatmentItem[], findingItems: string[] = []): Client {
  return {
    displayName: "P",
    factors: { treatments },
    finding: { treatment: findingItems.map((item) => ({ item, assessment: "a" })) },
  } as unknown as Client;
}

describe("planTreatmentSave — entry", () => {
  it("adds when there is no editing index", () => {
    const item = row({ id: "new" });
    expect(planTreatmentSave(input({ item }))).toEqual({ kind: "entry", name: "Metformin", item, index: null });
  });

  it("writes back by index for an existing row, whether scope is all or entry", () => {
    for (const scope of ["all", "entry"] as const) {
      expect(planTreatmentSave(input({ scope, editingIndex: 2 }))).toMatchObject({ kind: "entry", index: 2 });
    }
  });
});

describe("planTreatmentSave — medicine", () => {
  const med = (item: TreatmentItem, rows: TreatmentItem[]) =>
    planTreatmentSave(input({ item, scope: "medicine", editGroupName: "Metformin", rows }));

  it("carries the pre-rename name and the medicine-level patch", () => {
    const plan = med(row({ name: "Glucophage", reason: "T2D", doseAmount: 9, attachments: [att("a")] }), [row()]);
    expect(plan).toMatchObject({ kind: "medicine", name: "Glucophage", prevName: "Metformin", regenGroups: false });
    if (plan.kind !== "medicine") throw new Error("expected medicine plan");
    expect(plan.patch).toMatchObject({ name: "Glucophage", reason: "T2D", attachments: [att("a")] });
    expect(plan.patch).not.toHaveProperty("doseAmount");
  });

  it("regenerates groups and relabels doseUnit when the administration unit changes", () => {
    const plan = med(row({ administration: admin("capsule") }), [row({ name: " metformin ", administration: admin("tablet") })]);
    expect(plan).toMatchObject({ regenGroups: true, patch: { doseUnit: "capsule" } });
  });

  it("does not regenerate groups when the unit is unchanged", () => {
    const plan = med(row({ administration: admin("Tablet") }), [row({ administration: admin("tablet") })]);
    expect(plan).toMatchObject({ regenGroups: false });
    if (plan.kind === "medicine") expect(plan.patch).not.toHaveProperty("doseUnit");
  });

  it("looks up the previous administration by the pre-rename name", () => {
    const plan = med(row({ name: "Glucophage", administration: admin("tablet") }), [row({ administration: admin("tablet") })]);
    expect(plan).toMatchObject({ regenGroups: false });
  });

  it("ignores other drugs when looking up the previous administration", () => {
    const plan = med(row({ administration: admin("tablet") }), [row({ name: "Aspirin", administration: admin("tablet") })]);
    expect(plan).toMatchObject({ regenGroups: true });
  });
});

describe("applyTreatmentSave", () => {
  it("pushes an added row and fans its reason to siblings of the same drug", () => {
    const c = clientWith([row({ id: "a", reason: "old" }), row({ id: "b", name: "Aspirin", reason: "pain" })]);
    applyTreatmentSave(c, planTreatmentSave(input({ item: row({ id: "new", reason: "T2D" }) })));
    expect(c.factors!.treatments!.map((t) => [t.id, t.reason])).toEqual([["a", "T2D"], ["b", "pain"], ["new", "T2D"]]);
  });

  it("replaces the row at the editing index", () => {
    const c = clientWith([row({ id: "a" }), row({ id: "b", name: "Aspirin" })]);
    applyTreatmentSave(c, planTreatmentSave(input({ item: row({ id: "b", name: "Aspirin", doseAmount: 81 }), editingIndex: 1 })));
    expect(c.factors!.treatments!.map((t) => [t.id, t.doseAmount])).toEqual([["a", undefined], ["b", 81]]);
  });

  it("gives each client its own copy, so the draft and the persist payload never share a row", () => {
    const plan = planTreatmentSave(input({ item: row({ id: "new" }) }));
    const draft = clientWith([]);
    const payload = clientWith([]);
    applyTreatmentSave(draft, plan);
    applyTreatmentSave(payload, plan);
    draft.factors!.treatments![0].doseAmount = 5;
    expect(payload.factors!.treatments![0].doseAmount).toBeUndefined();
  });

  it("medicine plan: patches every row of the drug and renames its stored assessment", () => {
    const c = clientWith([row({ id: "a" }), row({ id: "b", name: "METFORMIN " }), row({ id: "c", name: "Aspirin" })], ["Metformin 500 mg"]);
    applyTreatmentSave(c, planTreatmentSave(input({ item: row({ name: "Glucophage", kind: "drug" }), scope: "medicine", editGroupName: "Metformin", rows: c.factors!.treatments! })));
    expect(c.factors!.treatments!.map((t) => t.name)).toEqual(["Glucophage", "Glucophage", "Aspirin"]);
    expect(c.finding!.treatment![0].item).toBe("Glucophage 500 mg");
  });
});

import { describe, it, expect } from "vitest";
import {
  duplicateTreatment, clearExtractedData, togglePin, removeTreatmentsById, mirrorAttachments,
  removeAttachment, deleteTreatmentPrompt, deleteMedicinePrompt,
} from "../../src/lib/treatment-mutations";
import type { Attachment, Client, TreatmentItem } from "../../src/lib/types";

function row(overrides: Partial<TreatmentItem> = {}): TreatmentItem {
  return { id: "id-1", name: "Metformin", start: "2026-01-01", ...overrides };
}
function att(key: string): Attachment {
  return { key, name: key, mediaType: "image/jpeg", bytes: 1, addedAt: "2026-01-01T00:00:00Z" };
}
function clientWith(treatments: TreatmentItem[]): Client {
  return { displayName: "P", factors: { treatments } } as Client;
}
function photoRow(overrides: Partial<TreatmentItem> = {}): TreatmentItem {
  return row({ extracted: { via: "photo", at: "t" }, attachments: [att("raw")], rawCaptureAttachmentKeys: ["raw"], ...overrides });
}

describe("duplicateTreatment", () => {
  it("copies the row under a new id, unpinned, keeping its attachments", () => {
    const d = duplicateTreatment(row({ pinned: true, doseAmount: 5, attachments: [att("a")] }), "new");
    expect(d).toMatchObject({ id: "new", name: "Metformin", doseAmount: 5, attachments: [att("a")] });
    expect(d.pinned).toBeUndefined();
  });
});

describe("clearExtractedData", () => {
  it("blanks every extracted field but leaves dose-period fields", () => {
    const t = row({ kind: "drug", description: "d", maker: "m", ingredients: [], administration: { unit: "tablet" } as TreatmentItem["administration"], doseAmount: 2 });
    clearExtractedData(t);
    expect(t).toEqual({ id: "id-1", name: "", start: "2026-01-01", doseAmount: 2, kind: undefined, description: undefined, maker: undefined, ingredients: undefined, administration: undefined });
  });
});

describe("togglePin", () => {
  it("flips pinned on the row with the id only", () => {
    const c = clientWith([row({ id: "a" }), row({ id: "b", pinned: true })]);
    togglePin(c, "a");
    togglePin(c, "b");
    expect(c.factors!.treatments!.map((t) => t.pinned)).toEqual([true, false]);
  });

  it("ignores an unknown id", () => {
    const c = clientWith([row({ id: "a" })]);
    togglePin(c, "zzz");
    expect(c.factors!.treatments![0].pinned).toBeUndefined();
  });
});

describe("removeTreatmentsById", () => {
  it("drops exactly the listed ids", () => {
    const c = clientWith([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
    removeTreatmentsById(c, new Set(["a", "c"]));
    expect(c.factors!.treatments!.map((t) => t.id)).toEqual(["b"]);
  });

  it("leaves a client without treatments alone", () => {
    const c = { displayName: "P", factors: {} } as Client;
    removeTreatmentsById(c, new Set(["a"]));
    expect(c.factors).toEqual({});
  });
});

describe("mirrorAttachments", () => {
  it("appends to every row of the medicine, de-duplicated, and no other", () => {
    const rows = [row({ id: "a", attachments: [att("x")] }), row({ id: "b", name: " metformin " }), row({ id: "c", name: "Aspirin" })];
    mirrorAttachments(rows, "Metformin", [att("x"), att("y")]);
    expect(rows.map((r) => (r.attachments ?? []).map((a) => a.key))).toEqual([["x", "y"], ["x", "y"], []]);
  });
});

describe("removeAttachment", () => {
  it("removes an ordinary attachment", () => {
    const t = row({ attachments: [att("a"), att("b")] });
    expect(removeAttachment(t, "a")).toBeNull();
    expect(t.attachments!.map((a) => a.key)).toEqual(["b"]);
  });

  it("refuses to remove the last raw-capture photo and leaves attachments intact", () => {
    const t = photoRow();
    expect(removeAttachment(t, "raw")).toMatch(/Can't remove the photo/);
    expect(t.attachments!.map((a) => a.key)).toEqual(["raw"]);
  });
});

describe("deleteTreatmentPrompt", () => {
  it("names the row, falling back when it has no name", () => {
    expect(deleteTreatmentPrompt(row(), [])).toBe("Remove Metformin? This can't be undone.");
    expect(deleteTreatmentPrompt(row({ name: "  " }), [])).toBe("Remove this treatment? This can't be undone.");
  });

  it("warns when the row holds the medicine's only raw-capture photo", () => {
    expect(deleteTreatmentPrompt(photoRow(), [])).toMatch(/only entry still holding the photo/);
  });

  it("does not warn when a sibling still holds a raw capture", () => {
    expect(deleteTreatmentPrompt(photoRow(), [photoRow({ id: "sib" })])).toBe("Remove Metformin? This can't be undone.");
  });
});

describe("deleteMedicinePrompt", () => {
  it("counts dose entries with the right plural", () => {
    expect(deleteMedicinePrompt({ name: "Metformin", rows: [row()] })).toBe("Remove Metformin and all 1 dose entry? This can't be undone.");
    expect(deleteMedicinePrompt({ name: "Metformin", rows: [row(), row()] })).toBe("Remove Metformin and all 2 dose entries? This can't be undone.");
  });
});

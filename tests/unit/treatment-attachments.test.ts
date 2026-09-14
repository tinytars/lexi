import { describe, it, expect } from "vitest";
import { attachmentsOf, groupAttachmentsOf } from "../../src/lib/attachment-store";
import { visionAttachmentsFor } from "../../src/lib/finding-vision";
import type { TreatmentItem } from "../../src/lib/types";

const img = (key: string) => ({ key, name: key, mediaType: "image/jpeg", bytes: 1, addedAt: "2026-01-01" });
const row = (id: string, attachments?: ReturnType<typeof img>[]): TreatmentItem =>
  ({ id, name: "Tirzepatide", kind: "drug", start: "2026-01-01", attachments } as unknown as TreatmentItem);

describe("groupAttachmentsOf", () => {
  // The point of the change: a photo documents the DRUG, so it must be visible from the medicine
  // whichever dose period it happens to be stored on — including already-stored per-row data, which
  // is why this is a union rather than a read of one canonical row.
  it("unions across the dose rows of one medicine", () => {
    expect(groupAttachmentsOf([row("a", [img("front.jpg")]), row("b"), row("c", [img("coa.pdf")])]).map((a) => a.key))
      .toEqual(["front.jpg", "coa.pdf"]);
  });

  it("de-duplicates the mirrored copies a medicine-level write leaves on every row", () => {
    const rows = [row("a", [img("front.jpg")]), row("b", [img("front.jpg")]), row("c", [img("front.jpg")])];
    expect(groupAttachmentsOf(rows)).toHaveLength(1);
  });

  it("still reads the legacy images[] shape", () => {
    const legacy = { images: ["1234-front.jpg"] } as unknown as TreatmentItem;
    expect(groupAttachmentsOf([legacy])).toEqual(attachmentsOf(legacy));
  });

  it("is empty for a medicine with no attachments anywhere", () => {
    expect(groupAttachmentsOf([row("a"), row("b")])).toEqual([]);
  });
});

describe("visionAttachmentsFor with mirrored attachments", () => {
  // Mirroring one photo across a long titration would otherwise send the same image N times and
  // spend the whole per-request cap on copies of it.
  it("sends one copy per distinct image, not one per dose row", () => {
    const context = { treatmentHistory: [row("a", [img("front.jpg")]), row("b", [img("front.jpg")]), row("c", [img("back.jpg")])] };
    expect(visionAttachmentsFor("treatmentAssessment", context, 4).map((a) => a.key)).toEqual(["front.jpg", "back.jpg"]);
  });

  it("still caps at maxCount once de-duplicated", () => {
    const rows = ["a", "b", "c", "d", "e"].map((k) => row(k, [img(`${k}.jpg`)]));
    expect(visionAttachmentsFor("treatmentAssessment", { treatmentHistory: rows }, 3)).toHaveLength(3);
  });
});

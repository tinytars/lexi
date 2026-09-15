import { describe, it, expect, vi } from "vitest";
import { uploadPendingImages, type AttachmentUploadDeps, type PendingImage } from "../../src/lib/treatment-attachment-upload";

function deps(overrides: Partial<AttachmentUploadDeps> = {}): AttachmentUploadDeps {
  return {
    compressImage: vi.fn(async (file: File) => ({ bytes: new Uint8Array(file.name.length), mediaType: "image/jpeg" })),
    buildAttachmentKey: vi.fn(async (_bytes: Uint8Array, name: string) => `key-${name}`),
    uploadAttachment: vi.fn(async () => {}),
    now: () => "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

function image(name: string, usedForIdentify?: boolean): PendingImage {
  return { file: new File([new Uint8Array([1])], name), usedForIdentify };
}

describe("uploadPendingImages", () => {
  it("returns empty results and calls nothing for an empty list", async () => {
    const d = deps();
    const result = await uploadPendingImages("client-1", [], d);
    expect(result).toEqual({ attachments: [], rawCaptureKeys: [] });
    expect(d.compressImage).not.toHaveBeenCalled();
  });

  it("accumulates one attachment per pending image, in order", async () => {
    const result = await uploadPendingImages("client-1", [image("a.jpg"), image("bb.jpg")], deps());
    expect(result.attachments.map((a) => a.name)).toEqual(["a.jpg", "bb.jpg"]);
    expect(result.attachments.map((a) => a.key)).toEqual(["key-a.jpg", "key-bb.jpg"]);
    expect(result.attachments[0].mediaType).toBe("image/jpeg");
    expect(result.attachments[0].addedAt).toBe("2026-08-28T00:00:00.000Z");
  });

  it("uses the compressed bytes length as the attachment's size", async () => {
    const result = await uploadPendingImages("client-1", [image("abcd.jpg")], deps());
    expect(result.attachments[0].bytes).toBe("abcd.jpg".length);
  });

  it("collects rawCaptureKeys only for images marked usedForIdentify", async () => {
    const result = await uploadPendingImages(
      "client-1",
      [image("a.jpg", true), image("b.jpg", false), image("c.jpg", true)],
      deps(),
    );
    expect(result.rawCaptureKeys).toEqual(["key-a.jpg", "key-c.jpg"]);
  });

  it("passes clientId and the compressed bytes through to uploadAttachment", async () => {
    const d = deps();
    await uploadPendingImages("client-42", [image("a.jpg")], d);
    expect(d.uploadAttachment).toHaveBeenCalledWith("client-42", expect.any(Uint8Array), "key-a.jpg");
  });

  it("rejects and stops accumulating when a dependency throws", async () => {
    const d = deps({
      uploadAttachment: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    await expect(uploadPendingImages("client-1", [image("a.jpg")], d)).rejects.toThrow("network down");
  });
});

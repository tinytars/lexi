import { describe, expect, it, vi } from "vitest";
import {
  buildAttachmentKey, attachmentUrl, attachmentsOf, attachFiles, MAX_ATTACHMENT_BYTES,
} from "../../src/lib/attachment-store";

describe("buildAttachmentKey", () => {
  it("prefixes with sha8 and sanitizes unsafe filename characters", async () => {
    const bytes = new TextEncoder().encode("photo bytes");
    const key = await buildAttachmentKey(bytes, "rash photo (1).jpg");
    expect(key).toMatch(/^[0-9a-f]{8}-rash_photo__1_\.jpg$/);
  });

  it("is deterministic for the same bytes and name", async () => {
    const bytes = new TextEncoder().encode("same bytes");
    const a = await buildAttachmentKey(bytes, "x.png");
    const b = await buildAttachmentKey(bytes, "x.png");
    expect(a).toBe(b);
  });

  it("leaves already-safe names untouched", async () => {
    const bytes = new TextEncoder().encode("abc");
    const key = await buildAttachmentKey(bytes, "IMG_2024-01-02.jpeg");
    expect(key.slice(9)).toBe("IMG_2024-01-02.jpeg");
  });
});

describe("attachmentUrl", () => {
  it("lowercases the client id and encodes the key", () => {
    expect(attachmentUrl("Alex", "ab12cd34-my file.jpg")).toBe("/api/raw/alex/ab12cd34-my%20file.jpg");
  });
});

describe("attachmentsOf", () => {
  it("returns attachments verbatim when present", () => {
    const attachments = [{ key: "k", name: "n", mediaType: "image/jpeg", bytes: 10, addedAt: "2026-01-01" }];
    expect(attachmentsOf({ attachments, images: undefined })).toBe(attachments);
  });

  it("folds legacy images[] into Attachment[], inferring mediaType from the extension", () => {
    const result = attachmentsOf({ attachments: undefined, images: ["ab12cd34-rash.jpg", "ef56gh78-report.pdf"] });
    expect(result).toEqual([
      { key: "ab12cd34-rash.jpg", name: "rash.jpg", mediaType: "image/jpeg", bytes: 0, addedAt: "" },
      { key: "ef56gh78-report.pdf", name: "report.pdf", mediaType: "application/pdf", bytes: 0, addedAt: "" },
    ]);
  });

  it("returns an empty array when neither field is present", () => {
    expect(attachmentsOf({ attachments: undefined, images: undefined })).toEqual([]);
  });

  it("falls back to octet-stream for an unrecognized extension", () => {
    const result = attachmentsOf({ attachments: undefined, images: ["ab12cd34-notes.xyz"] });
    expect(result[0].mediaType).toBe("application/octet-stream");
  });
});

describe("attachFiles", () => {
  it("uploads each file via PUT and returns one Attachment per file", async () => {
    const puts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "PUT") puts.push(url);
      return new Response(null, { status: 204 });
    }));
    const files = [
      new File([new Uint8Array([1, 2, 3])], "report.pdf", { type: "application/pdf" }),
      new File([new Uint8Array([4, 5, 6, 7])], "notes.txt", { type: "text/plain" }),
    ];
    const attachments = await attachFiles("Alex", files);
    expect(puts).toHaveLength(2);
    expect(attachments.map((a) => a.name)).toEqual(["report.pdf", "notes.txt"]);
    expect(attachments[0].mediaType).toBe("application/pdf");
    expect(attachments[1].bytes).toBe(4);
    expect(attachments.every((a) => /^[0-9a-f]{8}-/.test(a.key))).toBe(true);
  });

  it("caps at maxCount, silently dropping the rest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const files = [1, 2, 3].map((n) => new File([new Uint8Array([n])], `f${n}.txt`, { type: "text/plain" }));
    const attachments = await attachFiles("alex", files, { maxCount: 2 });
    expect(attachments).toHaveLength(2);
  });

  it("rejects a file over the size cap before ever uploading it", async () => {
    const put = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", put);
    const big = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "huge.pdf", { type: "application/pdf" });
    await expect(attachFiles("alex", [big])).rejects.toThrow(/too large/);
    expect(put).not.toHaveBeenCalled();
  });

  it("falls back to storing an image's original bytes when compression fails (e.g. HEIC)", async () => {
    // No createImageBitmap/OffscreenCanvas in the node test env — every image compress()
    // throws here, exercising the same fallback path a real HEIC decode failure would.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const original = new Uint8Array([9, 9, 9]);
    const file = new File([original], "photo.heic", { type: "image/heic" });
    const [attachment] = await attachFiles("alex", [file]);
    expect(attachment.mediaType).toBe("image/heic");
    expect(attachment.bytes).toBe(3);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAttachmentKey, attachmentsOf, attachFiles, putRaw, MAX_ATTACHMENT_BYTES,
} from "../../src/lib/attachment-store";
import { clearRawKeyring, rawKeyFor, setRawKeyring, setRawKeySink, withRawKey } from "../../src/lib/vault-raw-keys";
import { isSealed, openRaw } from "../../src/lib/raw-cipher";
import type { Vault } from "../../src/lib/types";

const KEY = "A".repeat(43) + "=";

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

describe("putRaw", () => {
  const bytes = new TextEncoder().encode("%PDF-1.7 a patient's report");

  /** Records what reached /api/raw, and the order the key write and the upload happened in. */
  function upload() {
    const sent: { url: string; body: Uint8Array }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: new Uint8Array(init.body as ArrayBuffer) });
      return new Response(null, { status: 204 });
    }));
    return sent;
  }

  afterEach(clearRawKeyring);

  it("seals the bytes, so the bucket never receives the document", async () => {
    setRawKeySink(async (id, file, key) => void withRawKey({ clients: {} } as Vault, id, file, key));
    const sent = upload();

    await putRaw("alex", "ab12cd34-report.pdf", bytes);

    expect(isSealed(sent[0].body)).toBe(true);
    expect(await openRaw(sent[0].body, "ab12cd34-report.pdf", rawKeyFor("alex", "ab12cd34-report.pdf"))).toEqual(bytes);
  });

  // The ordering the migration turns on: an upload that races ahead of its key write could leave a
  // sealed object nothing can ever open.
  it("saves the content key before it uploads the ciphertext", async () => {
    const order: string[] = [];
    setRawKeySink(async (id, file, key) => {
      withRawKey({ clients: {} } as Vault, id, file, key);
      order.push("key");
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      order.push("upload");
      return new Response(null, { status: 204 });
    }));

    await putRaw("alex", "ab12cd34-report.pdf", bytes);

    expect(order).toEqual(["key", "upload"]);
  });

  // A re-PUT is the same content-addressed bytes. Minting a second key would strand the copy already
  // in R2 if this upload then failed.
  it("reuses the key already on the ring rather than minting a second", async () => {
    setRawKeyring({ rawKeys: { alex: { "ab12cd34-report.pdf": KEY } } });
    let minted = 0;
    setRawKeySink(async () => void (minted += 1));
    const sent = upload();

    await putRaw("alex", "ab12cd34-report.pdf", bytes);

    expect(minted).toBe(0);
    expect(await openRaw(sent[0].body, "ab12cd34-report.pdf", KEY)).toEqual(bytes);
  });

  // No open vault is no place to record a key. Plaintext is recoverable; a sealed object with no key
  // is not — and the reader passes plaintext through, so the sweep can still seal it later.
  it("uploads plaintext when there is no vault to record a key in", async () => {
    const sent = upload();

    await putRaw("alex", "ab12cd34-report.pdf", bytes);

    expect(sent[0].body).toEqual(bytes);
  });

  // pdf.js cannot count the pages of an envelope, and the corpus checks its ceiling against this.
  it("carries the plaintext page count through unchanged", async () => {
    setRawKeySink(async (id, file, key) => void withRawKey({ clients: {} } as Vault, id, file, key));
    const sent = upload();

    await putRaw("alex", "ab12cd34-report.pdf", bytes, 9);

    expect(sent[0].url).toBe("/api/raw/alex/ab12cd34-report.pdf?pages=9");
  });
});

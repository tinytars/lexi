// `attachmentThumbUrl`'s three paths, with `fetch` stubbed in attachment-blob.test.ts's shape.
//
// What these cases measure is the FALLBACK and the write-once, not the resize: the pixel path needs
// `createImageBitmap` and `OffscreenCanvas`, neither of which node has, so `compressImage` arrives
// through `ThumbDeps` the way `uploadPendingImages` takes it (treatment-attachment-upload.ts:13-18).
// A suite that could not replace it could not run at all, and the arithmetic it would be testing is
// the browser's rather than this module's.
import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveObjectURL } from "node:buffer";
import { attachmentThumbUrl, attachmentBlobUrl, revokeAttachmentBlobs } from "../../src/lib/attachment-blob";
import { clearRawKeyring, setRawKeyring } from "../../src/lib/vault-raw-keys";
import { openRaw, sealRaw, isSealed } from "../../src/lib/raw-cipher";
import { bytesToBase64 } from "../../src/lib/base64";

const FULL = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const SMALL = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
const FILE = "ab12cd34-photo.jpg";
const THUMB_URL = `/api/raw/alex/${FILE}?thumb=1`;
const RAW_URL = `/api/raw/alex/${FILE}`;

const newKey = (): string => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
const bytesBehind = async (url: string): Promise<Uint8Array> =>
  new Uint8Array(await resolveObjectURL(url)!.arrayBuffer());

/** The resize, replaced: it reports the arguments it was handed and returns fixed bytes. */
const deps = () => ({ compressImage: vi.fn(async (_file: Blob, maxDim?: number, quality?: number) => ({ bytes: SMALL, mediaType: "image/jpeg", maxDim, quality })) }) as any;

const puts = (f: any) => f.mock.calls.filter((c: any[]) => c[1]?.method === "PUT");

afterEach(() => {
  revokeAttachmentBlobs();
  clearRawKeyring();
  vi.unstubAllGlobals();
});

describe("a thumbnail the store already holds", () => {
  it("is one request, opened under the ORIGINAL's content key, and no write", async () => {
    const key = newKey();
    setRawKeyring({ rawKeys: { alex: { [FILE]: key } } });
    // Sealed under `FILE` — the original's own entry. A thumbnail with a key of its own would need
    // its own ring entry, its own rotation and its own revocation; this has none of the three.
    const f = vi.fn(async (_url: string) => new Response((await sealRaw(SMALL, key)) as BodyInit));
    vi.stubGlobal("fetch", f);

    const url = await attachmentThumbUrl("Alex", FILE, deps());

    expect(await bytesBehind(url)).toEqual(SMALL);
    expect(f.mock.calls.map((c) => c[0])).toEqual([THUMB_URL]);
    expect(puts(f)).toEqual([]);
  });

  it("decrypts once for every chip drawing the same attachment", async () => {
    const f = vi.fn(async () => new Response(SMALL as BodyInit));
    vi.stubGlobal("fetch", f);

    const [a, b] = await Promise.all([attachmentThumbUrl("alex", FILE, deps()), attachmentThumbUrl("Alex", FILE, deps())]);

    expect(a).toBe(b);
    expect(f).toHaveBeenCalledOnce();
  });
});

describe("an attachment stored before thumbnails existed", () => {
  const served = (key?: string) => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      if (url.includes("thumb=1")) return new Response(null, { status: 404 });
      return new Response((key ? await sealRaw(FULL, key) : FULL) as BodyInit);
    });
    vi.stubGlobal("fetch", f);
    return f;
  };

  it("paints from the original, so the chip is never worse than it was", async () => {
    const f = served();

    expect(await bytesBehind(await attachmentThumbUrl("alex", FILE, deps()))).toEqual(FULL);
    expect(f.mock.calls.map((c) => c[0])).toContain(RAW_URL);
  });

  it("seals exactly one thumbnail from that same decrypted buffer", async () => {
    const key = newKey();
    setRawKeyring({ rawKeys: { alex: { [FILE]: key } } });
    const f = served(key);
    const d = deps();

    await attachmentThumbUrl("alex", FILE, d);
    await vi.waitFor(() => expect(puts(f)).toHaveLength(1));

    // The compressor was handed a blob of the DECRYPTED original and the chip's own dimensions, not
    // the upload's: one resize function, two call sites, different arguments (image-compress.ts:9).
    expect(await d.compressImage.mock.calls[0][0].bytes()).toEqual(FULL);
    expect(d.compressImage.mock.calls[0].slice(1)).toEqual([160, 0.6]);

    const [url, init] = puts(f)[0];
    expect(url).toBe(THUMB_URL);
    const body = new Uint8Array(init.body);
    expect(isSealed(body)).toBe(true);
    expect(await openRaw(body, FILE, key)).toEqual(SMALL);

    // One write per image ever: a second chip resolving the same key costs no request at all, which
    // is what makes the self-heal converge rather than re-seal on every view.
    const before = f.mock.calls.length;
    await attachmentThumbUrl("alex", FILE, d);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.mock.calls).toHaveLength(before);
  });

  it("writes nothing for a namespace whose content key this page does not hold", async () => {
    // Not a failure to fix: minting a key for a derivative of bytes we cannot prove we were entitled
    // to read is the one thing a key ring must never acquire. Such a page keeps falling back.
    const f = served();
    const d = deps();

    await attachmentThumbUrl("alex", FILE, d);
    await Promise.resolve();

    expect(puts(f)).toEqual([]);
    expect(d.compressImage).not.toHaveBeenCalled();
  });

  it("registers the decrypt so the viewer and the download share it", async () => {
    const f = served();

    const chip = await attachmentThumbUrl("alex", FILE, deps());

    expect(await attachmentBlobUrl("alex", FILE)).toBe(chip);
    expect(f.mock.calls.filter((c) => c[0] === RAW_URL)).toHaveLength(1);
  });

  it("resolves the chip even when the write is refused", async () => {
    // The route refuses a non-owner's thumbnail write with 403, and a clinician reading under a
    // consent grant must still see the picture — slow and correct, every view.
    const key = newKey();
    setRawKeyring({ rawKeys: { alex: { [FILE]: key } } });
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(null, { status: 403 });
      if (url.includes("thumb=1")) return new Response(null, { status: 404 });
      return new Response((await sealRaw(FULL, key)) as BodyInit);
    });
    vi.stubGlobal("fetch", f);

    expect(await bytesBehind(await attachmentThumbUrl("alex", FILE, deps()))).toEqual(FULL);
  });

  it("resolves the chip even when the resize throws", async () => {
    setRawKeyring({ rawKeys: { alex: { [FILE]: newKey() } } });
    served();
    const d = { compressImage: vi.fn(async () => { throw new Error("no OffscreenCanvas"); }) } as any;

    expect(await bytesBehind(await attachmentThumbUrl("alex", FILE, d))).toEqual(FULL);
  });
});

describe("the chip's own lifecycle", () => {
  it("does not cache a failure, so the key may arrive with the next save", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(SMALL as BodyInit));
    vi.stubGlobal("fetch", f);

    await expect(attachmentThumbUrl("alex", FILE, deps())).rejects.toThrow(/\(503\)/);
    expect(await bytesBehind(await attachmentThumbUrl("alex", FILE, deps()))).toEqual(SMALL);
  });

  it("stops being addressable once the vault closes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(SMALL as BodyInit)));
    const url = await attachmentThumbUrl("alex", FILE, deps());

    revokeAttachmentBlobs();
    await Promise.resolve();

    expect(resolveObjectURL(url)).toBeUndefined();
  });
});

import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveObjectURL } from "node:buffer";
import { attachmentBlobUrl, fetchAttachmentBytes, revokeAttachmentBlobs } from "../../src/lib/attachment-blob";
import { clearRawKeyring, setRawKeyring } from "../../src/lib/vault-raw-keys";
import { sealRaw } from "../../src/lib/raw-cipher";
import { bytesToBase64 } from "../../src/lib/base64";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const newKey = (): string => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
const served = (bytes: Uint8Array) => vi.fn(async (_url: string) => new Response(bytes as BodyInit));

/** What the browser would actually render from the returned URL. */
const bytesBehind = async (url: string): Promise<Uint8Array> =>
  new Uint8Array(await resolveObjectURL(url)!.arrayBuffer());

afterEach(() => {
  revokeAttachmentBlobs();
  clearRawKeyring();
});

describe("fetchAttachmentBytes", () => {
  it("asks /api/raw for the lowercased id and the encoded key", async () => {
    const fetchMock = served(PDF);
    vi.stubGlobal("fetch", fetchMock);

    await fetchAttachmentBytes("Alex", "ab12cd34-my file.jpg");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/raw/alex/ab12cd34-my%20file.jpg");
  });

  it("opens a sealed original with the key ring's content key", async () => {
    const key = newKey();
    setRawKeyring({ rawKeys: { alex: { "ab12cd34-report.pdf": key } } });
    vi.stubGlobal("fetch", served(await sealRaw(PDF, key)));

    expect(await fetchAttachmentBytes("alex", "ab12cd34-report.pdf")).toEqual(PDF);
  });

  // A store mid-migration still holds plaintext, and the ring has no key for it.
  it("passes an unsealed original through with no key in the ring", async () => {
    vi.stubGlobal("fetch", served(PDF));

    expect(await fetchAttachmentBytes("alex", "ab12cd34-report.pdf")).toEqual(PDF);
  });

  it("refuses rather than returning an error page as document bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(fetchAttachmentBytes("alex", "gone.pdf")).rejects.toThrow(/\(404\)/);
  });
});

describe("attachmentBlobUrl", () => {
  it("hands back a blob: URL holding the plaintext", async () => {
    const key = newKey();
    setRawKeyring({ rawKeys: { alex: { "ab12cd34-report.pdf": key } } });
    vi.stubGlobal("fetch", served(await sealRaw(PDF, key)));

    const url = await attachmentBlobUrl("alex", "ab12cd34-report.pdf");

    expect(url).toMatch(/^blob:/);
    expect(await bytesBehind(url)).toEqual(PDF);
  });

  // The strip, the viewer and the download link all open the same attachment at once.
  it("decrypts once for every surface showing the same attachment", async () => {
    const fetchMock = served(PDF);
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([
      attachmentBlobUrl("alex", "ab12cd34-report.pdf"),
      attachmentBlobUrl("Alex", "ab12cd34-report.pdf"),
    ]);

    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries after a failure instead of leaving the file blank for the page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(PDF as BodyInit));
    vi.stubGlobal("fetch", fetchMock);

    await expect(attachmentBlobUrl("alex", "ab12cd34-report.pdf")).rejects.toThrow();

    expect(await bytesBehind(await attachmentBlobUrl("alex", "ab12cd34-report.pdf"))).toEqual(PDF);
  });

  it("stops being addressable once the vault closes", async () => {
    vi.stubGlobal("fetch", served(PDF));
    const url = await attachmentBlobUrl("alex", "ab12cd34-report.pdf");

    revokeAttachmentBlobs();
    await Promise.resolve();

    expect(resolveObjectURL(url)).toBeUndefined();
  });
});

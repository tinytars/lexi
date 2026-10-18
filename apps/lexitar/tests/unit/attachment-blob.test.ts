import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveObjectURL } from "node:buffer";
import { attachmentBlobUrl, fetchAttachmentBytes, revokeAttachmentBlobs } from "../../src/lib/attachment-blob";
import { clearRawKeyring, setRawKeyRefresh, setRawKeyring } from "../../src/lib/vault-raw-keys";
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

  // The operator sweep seals an object and records its key in the vault blob after this page opened,
  // so the ring is behind the store. Without the retry the file stays broken until a reload.
  it("opens a sealed original whose key only arrives with a vault re-read", async () => {
    const key = newKey();
    let reads = 0;
    setRawKeyRefresh(async () => {
      reads += 1;
      setRawKeyring({ rawKeys: { alex: { "ab12cd34-report.pdf": key } } });
    });
    vi.stubGlobal("fetch", served(await sealRaw(PDF, key)));

    expect(await fetchAttachmentBytes("alex", "ab12cd34-report.pdf")).toEqual(PDF);
    expect(reads).toBe(1);
  });

  // The retry must not turn a genuine refusal into a silent loop: one re-read, then it propagates so
  // the UI can say so (packages/frame/attachment-url.svelte.ts).
  it("refuses a key the re-read vault does not hold either, after one read", async () => {
    let reads = 0;
    setRawKeyRefresh(async () => void (reads += 1));
    vi.stubGlobal("fetch", served(await sealRaw(PDF, newKey())));

    await expect(fetchAttachmentBytes("alex", "ab12cd34-report.pdf")).rejects.toThrow(/no content key/);
    expect(reads).toBe(1);
  });

  // A WRONG key is not a stale ring — the vault holds a key and it does not open the file. Re-reading
  // would cost a vault fetch per attachment and change nothing.
  it("does not re-read the vault for a key that is present but wrong", async () => {
    let reads = 0;
    setRawKeyRefresh(async () => void (reads += 1));
    setRawKeyring({ rawKeys: { alex: { "ab12cd34-report.pdf": newKey() } } });
    vi.stubGlobal("fetch", served(await sealRaw(PDF, newKey())));

    await expect(fetchAttachmentBytes("alex", "ab12cd34-report.pdf")).rejects.toThrow(/does not open it/);
    expect(reads).toBe(0);
  });

  it("refuses rather than returning an error page as document bytes", async () =>{
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

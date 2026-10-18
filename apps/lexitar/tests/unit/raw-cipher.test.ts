import { describe, expect, it } from "vitest";
import { RawKeyError, isSealed, openRaw, parseRawKeys, sealRaw } from "../../src/lib/raw-cipher";
import { bytesToBase64 } from "../../src/lib/base64";

const newKey = (): string => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

describe("sealRaw / openRaw", () => {
  it("returns the original bytes through a seal and an open", async () => {
    const key = newKey();
    expect(await openRaw(await sealRaw(PDF, key), "report.pdf", key)).toEqual(PDF);
  });

  it("changes the bytes it stores, so R2 never holds the document", async () => {
    const sealed = await sealRaw(PDF, newKey());
    expect(isSealed(sealed)).toBe(true);
    expect(Buffer.from(sealed).includes("%PDF")).toBe(false);
  });

  // The whole point of the dual-format reader: a store being migrated holds both at once.
  it("passes an unsealed object through untouched, with no key at all", async () => {
    expect(await openRaw(PDF, "report.pdf", undefined)).toBe(PDF);
  });

  it("names the file it could not open when no key was supplied", async () => {
    const sealed = await sealRaw(PDF, newKey());
    await expect(openRaw(sealed, "report.pdf", undefined)).rejects.toMatchObject({
      name: "RawKeyError",
      file: "report.pdf",
      reason: "missing",
    });
  });

  it("refuses a key that does not open it rather than returning garbage", async () => {
    const sealed = await sealRaw(PDF, newKey());
    await expect(openRaw(sealed, "report.pdf", newKey())).rejects.toMatchObject({ reason: "wrong" });
  });

  it("is a RawKeyError, so a caller can tell a key problem from a storage one", async () => {
    const sealed = await sealRaw(PDF, newKey());
    await expect(openRaw(sealed, "report.pdf", undefined)).rejects.toBeInstanceOf(RawKeyError);
  });
});

describe("parseRawKeys", () => {
  it("keeps a well-formed key map", () => {
    const key = newKey();
    expect(parseRawKeys({ rawKeys: { "ab12cd34-report.pdf": key } })).toEqual({ "ab12cd34-report.pdf": key });
  });

  it("returns an empty map for a body without one, which is the norm", () => {
    expect(parseRawKeys({})).toEqual({});
  });

  it("drops anything that is not a 32-byte base64 key", () => {
    expect(parseRawKeys({ rawKeys: { a: "not-a-key", b: 7, c: null } })).toEqual({});
  });

  it("caps how many keys a hostile body can make the Worker import", () => {
    const key = newKey();
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`f${i}.pdf`, key]));
    expect(Object.keys(parseRawKeys({ rawKeys: many }))).toHaveLength(200);
  });
});

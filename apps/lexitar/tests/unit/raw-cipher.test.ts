import { describe, expect, it } from "vitest";
import { RawKeyError, envelopeVersion, importRawKey, isSealed, openRaw, parseRawKeys, sealRaw } from "../../src/lib/raw-cipher";
import { encryptVaultV2 } from "@tinytars/vault/crypto";
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

describe("isSealed / envelopeVersion", () => {
  // raw-cipher.ts mirrors the version byte because @tinytars/vault does not export it, and a mirror
  // with nothing holding it is how a dependency bump silently reclassifies an entire store as
  // cleartext. This is what holds it: the number is read back out of a REAL seal, so a package that
  // renumbered its versions fails here instead of in production.
  it("pins the version byte a sealed original carries, measured from a real seal", async () => {
    const sealed = await sealRaw(PDF, newKey());
    expect(envelopeVersion(sealed)).toBe(3);
    expect(isSealed(sealed)).toBe(true);
  });

  // The envelope is shared with the vault blob, so magic alone cannot tell the two apart — and the
  // body this refuses is a patient's own vault ciphertext, which `openRaw` would otherwise hand back
  // to a caller labelled as the plaintext of their document.
  it("refuses a vault blob offered as an original — same envelope, version 2", async () => {
    const blob = await encryptVaultV2({ rawKeys: {} }, await importRawKey(newKey()));
    expect(envelopeVersion(blob)).toBe(2);
    expect(isSealed(blob)).toBe(false);
  });

  it("refuses a plaintext file whose first three bytes happen to read HD1", () => {
    const decoy = new Uint8Array(64);
    decoy.set(new TextEncoder().encode("HD1"));
    expect(isSealed(decoy)).toBe(false);
    expect(envelopeVersion(decoy)).toBe(0);
  });

  it("is null for bytes that are no envelope at all, which is how a store mid-migration reads", () => {
    expect(envelopeVersion(PDF)).toBe(null);
    expect(isSealed(PDF)).toBe(false);
  });
});

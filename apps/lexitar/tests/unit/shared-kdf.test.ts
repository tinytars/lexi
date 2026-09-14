// W72 item 15 — the extracted derivation, and the boundary it must NOT cross.
//
// The risk this change carries is not that the KDF is wrong; it is that a later "finish the dedup"
// merges the two envelopes now that they share a module. These tests are the tripwire for that: the
// derivation must be provably identical, and an EB1 blob must remain unreadable by the HD1 reader.

import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import { deriveAesKey, deriveBits, PBKDF2_ITERATIONS, SALT_LEN, IV_LEN } from "@tinytars/vault/kdf";
import { toArrayBuffer } from "@tinytars/vault/bytes";
import { encryptVault, decryptVault, deriveAuthHash } from "@tinytars/vault/crypto";
import { encryptJson, decryptJson } from "@tars/qbo/crypto";

const subtle = (globalThis.crypto as Crypto).subtle;
const salt = new Uint8Array(SALT_LEN).fill(7);

describe("shared KDF parameters", () => {
  it("keeps the values every already-encrypted blob was written under", () => {
    // These are not preferences. No existing EB1 or HD1 header records an iteration count or a salt
    // length, so changing one of these numbers makes every stored blob undecryptable with no error
    // that says so — it presents as "wrong passphrase". Moving them requires a version byte first.
    expect(PBKDF2_ITERATIONS).toBe(200_000);
    expect(SALT_LEN).toBe(16);
    expect(IV_LEN).toBe(12);
  });

  it("derives a non-extractable AES-GCM-256 key", async () => {
    const key = await deriveAesKey(subtle, "pw", salt);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("is deterministic in the passphrase and in the salt", async () => {
    const ct = async (pw: string, s: Uint8Array) => {
      const key = await deriveAesKey(subtle, pw, s);
      const iv = new Uint8Array(IV_LEN).fill(3);
      return Buffer.from(
        await subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(new Uint8Array([1, 2, 3]))),
      ).toString("hex");
    };
    const base = await ct("pw", salt);
    expect(await ct("pw", salt)).toBe(base);
    expect(await ct("pw!", salt)).not.toBe(base);
    expect(await ct("pw", new Uint8Array(SALT_LEN).fill(8))).not.toBe(base);
  });

  it("derives the same key from Node's webcrypto as from the global one", async () => {
    // The whole point of taking `subtle` as a parameter: the CLI/QBO side runs on node:crypto and the
    // app side on globalThis.crypto, and a blob written by one is read by the other.
    const iv = new Uint8Array(IV_LEN).fill(5);
    const nodeKey = await deriveAesKey(webcrypto.subtle as SubtleCrypto, "pw", salt);
    const globalKey = await deriveAesKey(subtle, "pw", salt);
    const nodeCt = new Uint8Array(
      await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, nodeKey, toArrayBuffer(new Uint8Array([9, 9]))),
    );
    const round = await subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, globalKey, toArrayBuffer(nodeCt));
    expect([...new Uint8Array(round)]).toEqual([9, 9]);
  });

  it("puts deriveBits in a different output space than the key, for the same inputs", async () => {
    const bits = await deriveBits(subtle, "pw", salt);
    expect(bits).toHaveLength(32);
    expect(await deriveBits(subtle, "pw", salt)).toEqual(bits);
    expect(await deriveBits(subtle, "pw2", salt)).not.toEqual(bits);
  });
});

describe("the auth hash stays in its own KDF domain", () => {
  it("is not the raw derivation of the same password and salt", async () => {
    // deriveAuthHash goes to the server. If it collapsed onto the KEK derivation, sending it would be
    // sending the key-wrapping secret. The "|auth" salt suffix is what keeps them apart, and this is
    // the assertion that fails if someone simplifies it away.
    const hash = await deriveAuthHash("pw", salt);
    const plain = await deriveBits(subtle, "pw", salt);
    const b64url = Buffer.from(plain).toString("base64url");
    expect(hash).not.toBe(b64url);
    expect(hash).toBe(await deriveAuthHash("pw", salt));
    expect(hash).not.toBe(await deriveAuthHash("pw", new Uint8Array(SALT_LEN).fill(8)));
  });
});

describe("EB1 and HD1 remain separate formats", () => {
  const pw = "same-passphrase-for-both";

  it("does not let the vault reader open a QBO token blob", async () => {
    const eb1 = await encryptJson({ refresh_token: "secret" }, pw);
    await expect(decryptVault(eb1, pw)).rejects.toThrow(/not an HD1 blob/);
  });

  it("does not let the QBO reader open a vault blob", async () => {
    const hd1 = await encryptVault({ clients: [] } as never, pw);
    await expect(decryptJson(hd1, pw)).rejects.toThrow(/not an EB1 blob/);
  });

  it("keeps the magic bytes distinct even though the key is now derived in one place", async () => {
    const eb1 = await encryptJson({ a: 1 }, pw);
    const hd1 = await encryptVault({ clients: [] } as never, pw);
    expect([...eb1.slice(0, 3)]).toEqual([0x45, 0x42, 0x31]);
    expect([...hd1.slice(0, 3)]).toEqual([0x48, 0x44, 0x31]);
    expect([...eb1.slice(0, 3)]).not.toEqual([...hd1.slice(0, 3)]);
  });

  it("still round-trips each format through its own reader", async () => {
    expect(await decryptJson(await encryptJson({ a: 1 }, pw), pw)).toEqual({ a: 1 });
    const v = { clients: [{ id: "x" }] };
    expect(await decryptVault(await encryptVault(v as never, pw), pw)).toEqual(v);
  });
});

// An HD1-prefixed ciphertext stand-in; >= 32 bytes passes the routes' shape check.
//
// THE VERSION BYTE IS NOW SET DELIBERATELY, which it was not until 2026-11-02. It sat at offset 3
// and was whatever the filler loop happened to put there — `(3 * 7) & 0xff`, i.e. 21, a version
// `@tinytars/vault` has never issued. Every route that read these fixtures checked the magic alone,
// so nothing noticed; the moment `isSealed` began reading the version as well (src/lib/raw-cipher.ts)
// twenty-three tests went red against a fixture that had never been a well-formed envelope. A
// fixture whose shape is an arithmetic accident can only pin a check that does not look at it.
//
// The two versions are the two payloads sharing the envelope: 2 is a vault blob, UTF-8 JSON under
// the account's DEK, and 3 is a sealed raw original, opaque bytes under a per-file content key.

/** HD1 version byte for a vault blob — what `vault/`, `chat/` and `regen-log/` bodies are. */
export const HD1_VAULT = 2;
/** HD1 version byte for a sealed raw original — what `raw/` and `text/` bodies are. */
export const HD1_RAW = 3;

export function hd1Blob(length = 40, version = HD1_VAULT): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(length);
  b[0] = 0x48; b[1] = 0x44; b[2] = 0x31;
  b[3] = version;
  for (let i = 4; i < length; i++) b[i] = (i * 7) & 0xff;
  return b;
}

/** A body the `raw/` routes accept: the same envelope, carrying the version a raw original has. */
export function sealedRawBlob(length = 40): Uint8Array<ArrayBuffer> {
  return hd1Blob(length, HD1_RAW);
}

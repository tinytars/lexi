// Sealing and opening a stored original, whichever of the two formats it is in.
//
// In src/ rather than functions/ because BOTH sides need it and imports run one way: the browser
// mints the key and seals the upload, the Worker opens what it was handed a key for.
//
// A raw object is AES-GCM ciphertext under a per-file CONTENT KEY minted in the browser and kept in
// the encrypted vault, so the deployment holds no standing key that opens a patient's files
// (VAULT.md). The key arrives on the request that needs it and is gone when the request ends.
//
// Every reader goes through here rather than calling decryptBytes itself, because a store being
// migrated holds both formats at once: an HD1 envelope is decrypted, anything else is passed
// through untouched. `%PDF`, `PK` and every image magic are distinguishable from `HD1`, which is
// what makes the two formats tellable apart without a database column to go stale.
import { decryptBytes, encryptBytes, isHD1 } from "@tinytars/vault/crypto";
import { b64ToBytes } from "@tinytars/vault/base64";
import { toArrayBuffer } from "@tinytars/vault/bytes";

/** file name (inside the client namespace) → base64 raw AES-GCM-256 content key. */
export type RawKeyMap = Record<string, string>;

// A key map is ~44 characters per file and the corpus carries at most MAX_CORPUS_DOCS documents.
// The ceiling is here so a hostile body cannot make the Worker import thousands of keys.
const MAX_KEYS = 200;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/; // 32 raw bytes

/** The caller supplied no key for a sealed object, or one that does not open it. */
export class RawKeyError extends Error {
  readonly file: string;
  readonly reason: "missing" | "wrong";
  constructor(file: string, reason: "missing" | "wrong") {
    super(reason === "missing" ? `no content key for "${file}"` : `the content key for "${file}" does not open it`);
    this.file = file;
    this.reason = reason;
    this.name = "RawKeyError";
  }
}

/** The `rawKeys` field of a request body, or an empty map — never a throw: a body without one is the norm. */
export function parseRawKeys(body: { rawKeys?: unknown }): RawKeyMap {
  const raw = body?.rawKeys;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: RawKeyMap = {};
  for (const [file, key] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_KEYS) break;
    if (typeof key === "string" && BASE64_KEY.test(key)) out[file] = key;
  }
  return out;
}

export async function importRawKey(base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(b64ToBytes(base64)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * The plaintext of one stored object.
 *
 * `file` is carried only so a refusal can name which document could not be opened; a refusal that
 * does not say which file leaves the browser nothing to heal.
 */
export async function openRaw(stored: Uint8Array, file: string, key: string | undefined): Promise<Uint8Array> {
  if (!isHD1(stored)) return stored;
  if (!key) throw new RawKeyError(file, "missing");
  try {
    return await decryptBytes(stored, await importRawKey(key));
  } catch {
    throw new RawKeyError(file, "wrong");
  }
}

/** Seals one object under a content key the caller supplied. The counterpart of `openRaw`. */
export async function sealRaw(plain: Uint8Array, key: string): Promise<Uint8Array> {
  return encryptBytes(plain, await importRawKey(key));
}

/** Whether these stored bytes are sealed — the one question a route asks without holding a key. */
export { isHD1 as isSealed };

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

/** Where the version byte sits: straight after the three magic bytes `HD1`. */
const MAGIC_LEN = 3;

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
  // `isHD1` and not `isSealed`, deliberately: the question here is "is this an envelope at all",
  // which is wider than "is this a well-formed raw original". A v2 blob offered as an original has
  // the magic, so it must be made to decrypt and fail — passing it through would hand a caller a
  // vault's ciphertext labelled as the plaintext of their document.
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

// The HD1 version byte a sealed ORIGINAL carries. The envelope is shared with the vault blob, which
// carries 2 and a UTF-8 JSON payload; a raw original is 3, opaque bytes, which is what `sealRaw`
// writes via `encryptBytes`. The package does not export the constant, so it is mirrored here and
// raw-cipher.test.ts pins it against a real `sealRaw` output — a package that renumbered its
// versions would fail that test rather than silently classify every object as cleartext.
const HD1_VERSION_BYTES = 3;

/**
 * Whether these stored bytes are sealed — the one question a route asks without holding a key.
 *
 * This is a FORMAT check and not a proof of encryption, and the distinction is load-bearing: the
 * deployment holds no key, so it can measure the envelope's shape and nothing more. A body that
 * carries the magic, the right version and the header length passes, whatever is behind it. What
 * the strictness buys is that a plaintext file whose first three bytes happen to read `HD1` no
 * longer passes on the magic alone, and that a vault blob offered as an original is refused.
 */
export function isSealed(stored: Uint8Array): boolean {
  return envelopeVersion(stored) === HD1_VERSION_BYTES;
}

/**
 * The HD1 envelope's version byte, or null for bytes that are not an envelope at all.
 *
 * Exported so an audit record can carry what was MEASURED rather than what the code above it
 * asserts. `sealed: true` logged on the far side of the only refusal that can reach that line is a
 * tautology, and a field that cannot disagree with its own code cannot report the day the code is
 * wrong. A version here is also the one diagnostic that distinguishes the two ways `isSealed` says
 * no: `null` is a body that is not an envelope, `2` is a vault blob offered as an original.
 */
export function envelopeVersion(stored: Uint8Array): number | null {
  return isHD1(stored) ? (stored[MAGIC_LEN] ?? null) : null;
}

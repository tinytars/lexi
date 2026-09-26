// The key ring: which content key opens which stored original, for this browser's open vault.
//
// The keys live in the vault blob (`Vault.rawKeys`), so they are already encrypted at rest under the
// vault DEK and inherit its principal set, its revocation and its rotation — none of which had to be
// built. This module is the read side of that: it holds the decrypted ring for the life of the page
// so a thumbnail, a chat send and a corpus request do not each have to be handed one.
//
// AMBIENT, like corpus-warm-client.ts's `corpusAttached`, and for the same reason: the alternative
// is threading a key map through a dozen component props to reach an <img src>, which puts a
// storage detail into the signature of every leaf that shows an attachment.
import type { RawKeyMap } from "./raw-cipher";
import { openRaw } from "./raw-cipher";
import { normalizeClientId } from "./client-id";
import { bytesToBase64 } from "./base64";
import type { Vault } from "./types";

type Keyring = Record<string, RawKeyMap>;

let keyring: Keyring = {};

/**
 * Writes one content key into the vault blob and returns once the write has landed.
 *
 * It applies the key to the in-memory vault SYNCHRONOUSLY and only then awaits the write, which is
 * what lets two uploads mint at once: each reads a vault the other has already added its key to, so
 * neither whole-blob write drops the other's key.
 */
type KeySink = (clientId: string, file: string, key: string) => Promise<void>;

let sink: KeySink | null = null;

type KeyRefresh = () => Promise<void>;

let refresh: KeyRefresh | null = null;
let refreshing: Promise<void> | null = null;

/** Publishes the open vault's keys. Called wherever the decrypted vault becomes the app's state. */
export function setRawKeyring(vault: Pick<Vault, "rawKeys">): void {
  keyring = Object.fromEntries(Object.entries(vault.rawKeys ?? {}).map(([id, keys]) => [normalizeClientId(id), keys]));
}

/** Locking the vault takes the keys with it — nothing decryptable should outlive the session. */
export function clearRawKeyring(): void {
  keyring = {};
  sink = null;
  refresh = null;
  refreshing = null;
}

/** Registered once where the vault is held, beside the sink. `null` while it is closed. */
export function setRawKeyRefresh(fn: KeyRefresh | null): void {
  refresh = fn;
}

/**
 * Re-reads the stored vault so the ring catches up with keys recorded OUT OF BAND.
 *
 * The operator sweep (scripts/raw-encrypt-backfill.ts) seals objects and writes their keys straight
 * into the stored blob, so a page whose vault was opened before it ran holds a ring missing every
 * one of them — and `openRaw` then refuses files the vault can in fact open. This is the only way
 * back without a reload.
 *
 * Serialised on one in-flight read: a record with a dozen unopenable attachments must cost one
 * vault fetch, not a dozen. A no-op with no open vault.
 *
 * It never rejects. A catch-up that fails leaves the ring as it was, and the caller's own refusal —
 * `no content key for "x"` — is a truer thing to show than whatever went wrong fetching the vault.
 */
export function refreshRawKeyring(): Promise<void> {
  const read = refresh;
  if (!read) return Promise.resolve();
  refreshing ??= read()
    .catch(() => undefined)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** One client's keys, as the `rawKeys` field of a request body. Empty until anything is sealed. */
export function rawKeysFor(clientId: string): RawKeyMap {
  return keyring[normalizeClientId(clientId)] ?? {};
}

/**
 * The two fields every attached-inference request body carries: whose record, and what opens it.
 *
 * One helper rather than two fields spelled out at six call sites, because they are a pair — a
 * request naming a record without the keys to its documents is refused with `corpus_key_missing`,
 * and that is a failure the browser can only discover at run time.
 */
export function corpusSubject<T extends string | null | undefined>(clientId: T): { clientId: T; rawKeys: RawKeyMap } {
  return { clientId, rawKeys: clientId ? rawKeysFor(clientId) : {} };
}

export function rawKeyFor(clientId: string, file: string): string | undefined {
  return rawKeysFor(clientId)[file];
}

/** The plaintext of bytes just fetched from /api/raw — a pass-through while a store is migrating. */
export function openStored(stored: Uint8Array, clientId: string, file: string): Promise<Uint8Array> {
  return openRaw(stored, file, rawKeyFor(clientId, file));
}

/**
 * The vault with one more key recorded, and the ring updated to match.
 *
 * Both halves in one call because they cannot diverge: a key saved to the vault but not published
 * leaves this page unable to open the file it just uploaded, and the reverse loses it at reload.
 */
export function withRawKey(vault: Vault, clientId: string, file: string, key: string): Vault {
  const id = normalizeClientId(clientId);
  const keys = { ...vault.rawKeys?.[id], [file]: key };
  keyring = { ...keyring, [id]: keys };
  return { ...vault, rawKeys: { ...vault.rawKeys, [id]: keys } };
}

/**
 * The vault with every key the STORED blob holds that this copy does not, and the ring to match.
 *
 * The ring only: the rest of the in-memory vault may hold edits this page has not saved, so adopting
 * a whole stored vault to catch up on keys would discard them. A merge cannot lose a key either way
 * — content keys are append-only per file (attachment-store.ts reuses one rather than replacing it)
 * — so this copy wins for a file it just minted and the stored blob wins for one it has never seen.
 */
export function withStoredRawKeys(vault: Vault, stored: Vault["rawKeys"]): Vault {
  // Normalized, like withRawKey writes and setRawKeyring reads: an id spelled two ways would
  // otherwise merge into two entries and the ring would keep whichever came last.
  const merged: NonNullable<Vault["rawKeys"]> = {};
  const add = (from: Vault["rawKeys"]) => {
    for (const [id, keys] of Object.entries(from ?? {})) {
      const norm = normalizeClientId(id);
      merged[norm] = { ...merged[norm], ...keys };
    }
  };
  add(stored);
  add(vault.rawKeys);
  keyring = merged;
  return { ...vault, rawKeys: merged };
}

/** Registered once where the vault is held. `null` while it is closed — nothing can record a key. */
export function setRawKeySink(fn: KeySink | null): void {
  sink = fn;
}

/**
 * A fresh content key for one file, DURABLE BEFORE ITS CIPHERTEXT EXISTS.
 *
 * The ordering is the whole point. A sealed object whose key was never saved is unopenable, and
 * because the corpus reads every `raw_objects` row under a namespace, one of them refuses that
 * patient's every question with `corpus_key_missing` — a loss no later sweep can undo. Saving first
 * risks only an unused key, and an unused key costs nothing: `openRaw` passes plaintext through
 * whether or not the ring holds one for it.
 *
 * Returns null when there is no open vault to record it in, which is the signal to store plaintext.
 */
export async function mintRawKey(clientId: string, file: string): Promise<string | null> {
  const write = sink;
  if (!write) return null;
  const key = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  await write(normalizeClientId(clientId), file, key);
  return key;
}

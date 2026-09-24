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
import type { Vault } from "./types";

type Keyring = Record<string, RawKeyMap>;

let keyring: Keyring = {};

/** Publishes the open vault's keys. Called wherever the decrypted vault becomes the app's state. */
export function setRawKeyring(vault: Pick<Vault, "rawKeys">): void {
  keyring = Object.fromEntries(Object.entries(vault.rawKeys ?? {}).map(([id, keys]) => [normalizeClientId(id), keys]));
}

/** Locking the vault takes the keys with it — nothing decryptable should outlive the session. */
export function clearRawKeyring(): void {
  keyring = {};
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
  const keys = { ...(vault.rawKeys?.[id] ?? {}), [file]: key };
  keyring = { ...keyring, [id]: keys };
  return { ...vault, rawKeys: { ...vault.rawKeys, [id]: keys } };
}

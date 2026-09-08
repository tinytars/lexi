import { decryptVaultV2 } from "../security/crypto";

// W72 — the unlocked-session key material, as one object with one transition each way.
//
// docs/cross-app/10 names this as Phase A's only prerequisite: "consolidate App.svelte's DEK/session
// state machine … as its own careful, tested commit — not a drive-by during the package move. This
// touches live PHI-handling code and needs its own verification pass."
//
// The argument is not only tidiness. Until now `dek`, `vaultR2Id` and the two private keys were four
// separate `$state` declarations, set in four separate assignments and cleared in four more. Nothing
// made them move together, so a HALF-OPEN session was representable: `backToRoster()` clears the DEK
// and the r2 id, and any future path that forgot one would leave a live data key in memory for a
// vault the user believes they have closed. Here that state cannot be expressed — `close()` clears
// everything, and `isOpen` is derived rather than tracked.
//
// What is deliberately NOT here: `vault` itself, the decrypted record. It has 86 references in
// App.svelte and is mutated by every save, so moving it is a much larger edit than moving the key
// material, and a larger edit on PHI-handling code than this one commit should carry. The key
// material is the part whose lifetime is a security property; the plaintext record's lifetime is the
// same as the key's by construction, because it cannot be re-read without one.

/**
 * A vault this session may open on someone else's behalf, and the envelope that opens it. The shape
 * the provider roster and the support console both hand to the host — one drill-in, not two that
 * agree by coincidence.
 */
export interface VaultEntry {
  patientAccountId: string;
  displayName: string;
  email: string | null;
  r2Key: string;
  envelope: { wrappedDEK: string; ephemeralPublicKeyJwk: JsonWebKey };
}

export interface VaultSession {
  /** The current vault's data key, or null when no vault is open. */
  readonly dek: CryptoKey | null;
  /** The current vault's R2 id (slug of its r2_key), or null. */
  readonly r2Id: string | null;
  /**
   * The signed-in owner's account private key, retained for the session so Account settings can
   * re-wrap it when adding a login method. Null in a provider or support session.
   */
  readonly ownerKey: CryptoKey | null;
  /** A provider account's private key, which unwraps each patient's envelope. Null for an owner. */
  readonly providerKey: CryptoKey | null;
  /** True only when a vault is genuinely open — derived, never tracked separately. */
  readonly isOpen: boolean;

  /** Opens a vault: the id and the key that decrypts it, together or not at all. */
  open(r2Id: string, dek: CryptoKey): void;
  /** Retains the owner's account key for this session. */
  setOwnerKey(key: CryptoKey | null): void;
  /** Retains a provider's account key for this session. */
  setProviderKey(key: CryptoKey | null): void;
  /**
   * Closes the open vault. Clears the data key and the id together.
   *
   * Does NOT clear the provider key: a provider who leaves one patient is still signed in and still
   * needs their own key to open the next. That asymmetry was already the behaviour of
   * `backToRoster()`; stating it here is what stops it being re-derived incorrectly later.
   */
  close(): void;
  /** Ends the whole session — every key, including the provider's. */
  signOut(): void;
}

export function createVaultSession(): VaultSession {
  let dek = $state<CryptoKey | null>(null);
  let r2Id = $state<string | null>(null);
  let ownerKey = $state<CryptoKey | null>(null);
  let providerKey = $state<CryptoKey | null>(null);

  return {
    get dek() {
      return dek;
    },
    get r2Id() {
      return r2Id;
    },
    get ownerKey() {
      return ownerKey;
    },
    get providerKey() {
      return providerKey;
    },
    get isOpen() {
      // Both, though the API makes it impossible for them to disagree — `open` sets the pair and
      // `close` clears the pair. That redundancy is deliberate defence in depth and is deliberately
      // NOT testable: a mutation to `r2Id !== null` alone passes every test in vault-session.test.ts,
      // because reaching the state it would misreport requires bypassing this object. Noted rather
      // than covered by a contrived test.
      return dek !== null && r2Id !== null;
    },
    open(nextId: string, nextDek: CryptoKey) {
      r2Id = nextId;
      dek = nextDek;
    },
    setOwnerKey(key: CryptoKey | null) {
      ownerKey = key;
    },
    setProviderKey(key: CryptoKey | null) {
      providerKey = key;
    },
    close() {
      dek = null;
      r2Id = null;
    },
    signOut() {
      dek = null;
      r2Id = null;
      ownerKey = null;
      providerKey = null;
    },
  };
}

/**
 * Decrypts a vault blob and opens the session on it in one step, shared by every path that unlocks
 * a vault — the signed-in owner's own, and a provider's drill-in to a patient's. `fetchBlob` stays a
 * caller-supplied thunk because fetching it (the R2 route, the ETag it must remember for later saves)
 * is app-local, not frame-generic.
 */
export async function openVault<V>(session: VaultSession, id: string, dek: CryptoKey, fetchBlob: (id: string) => Promise<Uint8Array>): Promise<V> {
  const vault = await decryptVaultV2<V>(await fetchBlob(id), dek);
  session.open(id, dek);
  return vault;
}

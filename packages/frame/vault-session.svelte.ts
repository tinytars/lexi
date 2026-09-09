import type { VaultSession } from "../security/vault-session";

export type { VaultEntry, VaultSession } from "../security/vault-session";
export { openVault } from "../security/vault-session";

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
//
// `VaultEntry`/`VaultSession` (the shapes) and `openVault` (rune-free logic) live in
// packages/security/vault-session.ts — this file imports them back and adds only the one thing that
// cannot move there: the $state-backed implementation, which is Svelte-coupled by construction.

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

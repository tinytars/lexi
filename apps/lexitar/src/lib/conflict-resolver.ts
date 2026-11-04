// Extracted from App.svelte's resolveConflictKeepMine/resolveConflictTakeTheirs (W79 phase 3b). Plain
// TS, no runes — every piece of App-owned state this needs is an injected getter/setter, following
// nav-controller.ts's shape (the `resolving` flag stays App-owned rather than moving into private
// factory state, since App's markup reads it directly for the disabled/"working…" UI).

import type { Vault } from "./types";
import { withStoredRawKeys } from "./vault-raw-keys";
import { VaultConflictError } from "@tinytars/vault/vault-sink";

export interface ConflictResolverDeps {
  getVault: () => Vault | null;
  setVault: (v: Vault) => void;
  getDek: () => CryptoKey | null;
  getR2Id: () => string | null;
  getConflict: () => VaultConflictError | null;
  setConflict: (e: VaultConflictError | null) => void;
  getResolving: () => boolean;
  setResolving: (v: boolean) => void;
  fetchVaultBlob: (id: string) => Promise<Uint8Array>;
  saveVault: (vault: Vault, id: string, dek: CryptoKey) => Promise<void>;
  decryptVault: (blob: Uint8Array, dek: CryptoKey) => Promise<Vault>;
}

export interface ConflictResolver {
  /**
   * Keep this tab's version: re-read the current version token, then write what is in memory over it.
   *
   * Labelled in the UI as overwriting the other side, because it does. Offered because the alternative
   * — discarding this tab — throws away every edit since unlock, and only the patient can weigh that.
   */
  resolveConflictKeepMine(): Promise<void>;
  /** Discard this tab's edits and take the stored record. Destructive, and says so. */
  resolveConflictTakeTheirs(): Promise<void>;
}

export function createConflictResolver(deps: ConflictResolverDeps): ConflictResolver {
  async function resolveConflictKeepMine(): Promise<void> {
    const vault = deps.getVault();
    const dek = deps.getDek();
    const r2Id = deps.getR2Id();
    if (!vault || !dek || !r2Id || deps.getResolving()) return;
    deps.setResolving(true);
    try {
      // The stored blob is read on EVERY resolution, not only when the refusal handed back no version
      // token. Overwriting the other side's edits is what this button promises; overwriting its CONTENT
      // KEYS is not, and a whole-vault write does both unless the keys are merged back in first.
      //
      // Measured in production 2026-11-04: an image uploaded from one device at 8:03 AM PT is in R2 at
      // 115,902 bytes with no key in the vault, because the other device resolved a conflict from an
      // in-memory vault minted before that key existed. The ciphertext is in R2, which has no
      // conflict control of its own, so it survived the write that discarded the only means of opening
      // it — and no snapshot predating the key can give it back. That file cannot be opened by anyone,
      // ever.
      //
      // The merge is safe in both directions, for the reason withStoredRawKeys states: a content key is
      // append-only per file (attachment-store.ts reuses one rather than replacing it), so this copy
      // wins for a file it just minted and the stored blob wins for one it has never seen. Re-reading
      // also re-arms If-Match on the version actually being overwritten, which is the one the patient
      // is choosing to replace at the moment they click.
      const stored = await deps.decryptVault(await deps.fetchVaultBlob(r2Id), dek);
      const merged = withStoredRawKeys(vault, stored.rawKeys);
      deps.setVault(merged);
      await deps.saveVault(merged, r2Id, dek);
      deps.setConflict(null);
    } catch (e) {
      if (e instanceof VaultConflictError) deps.setConflict(e);
    } finally {
      deps.setResolving(false);
    }
  }

  async function resolveConflictTakeTheirs(): Promise<void> {
    const dek = deps.getDek();
    const r2Id = deps.getR2Id();
    if (!dek || !r2Id || deps.getResolving()) return;
    deps.setResolving(true);
    try {
      const blob = await deps.fetchVaultBlob(r2Id);
      const theirs = await deps.decryptVault(blob, dek);
      // Discarding this tab's EDITS must not discard the content keys it minted. Those keys are not an
      // edit the patient is choosing between: their ciphertext is already uploaded, and the key is the
      // only thing that can ever open it. Dropping one here strands bytes nobody can read.
      const mine = deps.getVault();
      deps.setVault(mine ? withStoredRawKeys(theirs, mine.rawKeys) : theirs);
      deps.setConflict(null);
    } finally {
      deps.setResolving(false);
    }
  }

  return { resolveConflictKeepMine, resolveConflictTakeTheirs };
}

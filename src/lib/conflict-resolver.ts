// Extracted from App.svelte's resolveConflictKeepMine/resolveConflictTakeTheirs (W79 phase 3b). Plain
// TS, no runes — every piece of App-owned state this needs is an injected getter/setter, following
// nav-controller.ts's shape (the `resolving` flag stays App-owned rather than moving into private
// factory state, since App's markup reads it directly for the disabled/"working…" UI).

import type { Vault } from "./types";
import { VaultConflictError, rememberVaultEtag } from "@tinytars/vault/vault-sink";

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
      const conflict = deps.getConflict();
      rememberVaultEtag(r2Id, conflict?.serverEtag ?? null);
      if (!conflict?.serverEtag) await deps.fetchVaultBlob(r2Id); // no token handed back: re-read for one
      await deps.saveVault(vault, r2Id, dek);
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
      deps.setVault(await deps.decryptVault(blob, dek));
      deps.setConflict(null);
    } finally {
      deps.setResolving(false);
    }
  }

  return { resolveConflictKeepMine, resolveConflictTakeTheirs };
}

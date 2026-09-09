// Who can open this vault, and the re-key that changes the answer.
//
// The first of App's five controller extractions. This cluster was ~110 lines of the
// component: six `$state` declarations, three `$derived` filters and seven async handlers, including
// `rotateVaultKey` — the single most consequential operation in the app, whose only test was an e2e
// that by construction cannot interrupt it.
//
// Same getter-parameterized factory shape used consistently across this package's controllers: the
// host passes thunks rather than values, so this module never captures a stale vault. What stays with
// App is what App owns — the decrypted record and the sink that writes it.

import type { VaultSession } from "./vault-session.svelte";
import { generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { bytesToB64 } from "@tinytars/vault/base64";
import { listMyProviders, lookupProvider, grantProvider, revokeProvider, type ProviderLinkView } from "@tinytars/vault/auth-grants";
import { approveSupport, approveSupportAsProvider } from "@tinytars/vault/auth-support";
import { getVaultPrincipals, stageVaultRotation, rotateVault } from "@tinytars/vault/auth-recovery";

export interface VaultPrincipalsDeps<V> {
  /** The decrypted record, read fresh — never captured. Still App's, along with the sink below. */
  getVault: () => V | null;
  /** The unlocked-session key material. Stable identity, its own module. */
  session: VaultSession;
  /** Re-encrypts and writes the vault under a given id and key. App owns the sink. */
  saveVault: (vault: V, r2Id: string, dek: CryptoKey) => Promise<unknown>;
  /**
   * The provider-side pair (approve/revoke a support agent's roster grant) reports through App's
   * shared error line rather than this panel's, because it renders in the clinician console where
   * the Access modal is not mounted. Behaviour preserved from the extraction, not a new idea.
   */
  reportError: (message: string | null) => void;
}

export interface VaultPrincipals {
  readonly open: boolean;
  readonly providers: ProviderLinkView[];
  readonly busy: boolean;
  readonly error: string | null;
  /** Bound to the add-provider input. */
  newProviderEmail: string;
  /** Bound to the approval TTL select. */
  ttlHours: number;

  /** Support agents who have asked and not yet been approved. */
  readonly pendingSupport: ProviderLinkView[];
  /** Everything that is not a pending support request — clinicians plus approved support. */
  readonly activeAccess: ProviderLinkView[];
  /** Approved support agents, as the clinician console lists them. */
  readonly activeSupport: ProviderLinkView[];

  openPanel(): Promise<void>;
  closePanel(): void;
  /** Reloads the list without opening the panel. Non-fatal: an empty section beats a blocked boot. */
  refreshQuietly(): Promise<void>;
  addProvider(): Promise<void>;
  revoke(p: ProviderLinkView): Promise<void>;
  approve(p: ProviderLinkView): Promise<void>;
  approveAsProvider(p: ProviderLinkView): Promise<void>;
  revokeAsProvider(p: ProviderLinkView): Promise<void>;
  /**
   * Mints a fresh DEK, re-encrypts the vault under it, re-wraps it to every remaining principal and
   * swaps. Exposed because a pending rotation from a prior session is resumed at boot.
   */
  rotateVaultKey(): Promise<void>;
  /** Clears panel state on sign-out. */
  reset(): void;
}

export function createVaultPrincipals<V>(deps: VaultPrincipalsDeps<V>): VaultPrincipals {
  let open = $state(false);
  let providers = $state<ProviderLinkView[]>([]);
  let newProviderEmail = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let ttlHours = $state(72);

  const pendingSupport = $derived(providers.filter((p) => p.kind === "support" && p.status === "invited"));
  const activeAccess = $derived(providers.filter((p) => !(p.kind === "support" && p.status === "invited")));
  const activeSupport = $derived(providers.filter((p) => p.kind === "support" && p.status === "active"));

  /** The busy/error/reload envelope every handler here shares. */
  async function run(body: () => Promise<void>, report: (m: string | null) => void): Promise<void> {
    busy = true;
    report(null);
    try {
      await body();
      providers = await listMyProviders();
    } catch (e) {
      report((e as Error).message);
    } finally {
      busy = false;
    }
  }

  const toPanel = (m: string | null) => (error = m);

  async function rotateVaultKey(): Promise<void> {
    const vault = deps.getVault();
    const { session } = deps;
    if (!vault || !session.dek || !session.r2Id) return;
    const principals = await getVaultPrincipals();
    const newDek = await generateDEK();
    // The blob goes to a NEW object, reserved here, and the envelope commit below doubles as the
    // pointer swap. This used to re-encrypt in place and commit the matching envelopes four round
    // trips later; anything that interrupted that window — a dropped connection, a closed lid
    // mid-revoke — left every principal holding an envelope for a key the ciphertext no longer used.
    // An interruption before the commit now leaves the old blob and the old envelopes still agreeing,
    // and the abandoned object is ciphertext under a key nobody kept.
    const newVaultId = await stageVaultRotation(principals.vaultId);
    await deps.saveVault(vault, newVaultId, newDek);
    const targets = [
      { accountId: principals.selfAccountId, publicKeyJwk: principals.selfPublicKeyJwk },
      // A patient who removed org recovery must not have it silently restored by the next re-key.
      ...(principals.orgRecoveryRevokedAt ? [] : [{ accountId: principals.orgAccountId, publicKeyJwk: principals.orgPublicKeyJwk }]),
      ...principals.providers,
    ];
    const envelopes = await Promise.all(
      targets.map(async (t) => {
        const e = await wrapDEKForPublicKey(newDek, t.publicKeyJwk);
        return { principalAccountId: t.accountId, wrappedDEK: bytesToB64(e.wrappedDEK), ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk };
      }),
    );
    await rotateVault({ vaultId: principals.vaultId, newVaultId, envelopes });
    session.open(newVaultId, newDek);
  }

  return {
    get open() {
      return open;
    },
    get providers() {
      return providers;
    },
    get busy() {
      return busy;
    },
    get error() {
      return error;
    },
    get newProviderEmail() {
      return newProviderEmail;
    },
    set newProviderEmail(v: string) {
      newProviderEmail = v;
    },
    get ttlHours() {
      return ttlHours;
    },
    set ttlHours(v: number) {
      ttlHours = v;
    },
    get pendingSupport() {
      return pendingSupport;
    },
    get activeAccess() {
      return activeAccess;
    },
    get activeSupport() {
      return activeSupport;
    },

    async openPanel() {
      open = true;
      error = null;
      try {
        providers = await listMyProviders();
      } catch (e) {
        error = (e as Error).message;
      }
    },

    closePanel() {
      open = false;
    },

    async refreshQuietly() {
      try {
        providers = await listMyProviders();
      } catch {
        /* non-fatal; the section just stays empty */
      }
    },

    async addProvider() {
      const emailInput = newProviderEmail.trim();
      const dek = deps.session.dek;
      if (!emailInput || !dek) return;
      busy = true;
      error = null;
      try {
        const provider = await lookupProvider(emailInput);
        // Not an exception, and deliberately not a reload either: a typo is an ordinary outcome, and
        // re-listing for it would be a round trip that changes nothing.
        if (!provider) {
          error = "No provider found with that email.";
          return;
        }
        await grantProvider(dek, provider);
        newProviderEmail = "";
        providers = await listMyProviders();
      } catch (e) {
        error = (e as Error).message;
      } finally {
        busy = false;
      }
    },

    async revoke(p: ProviderLinkView) {
      await run(async () => {
        await revokeProvider(p.linkId);
        // True forward-secret revocation for SUPPORT: re-key the vault so a support agent
        // who cached the DEK can no longer decrypt it. Clinician revoke stays delete-only. Denying a
        // pending (never-active) support request needs no rotation — support never held the DEK.
        if (p.kind === "support" && p.status === "active") await rotateVaultKey();
      }, toPanel);
    },

    async approve(p: ProviderLinkView) {
      if (!deps.session.dek || !p.publicKeyJwk) return;
      const dek = deps.session.dek;
      const jwk = p.publicKeyJwk;
      await run(() => approveSupport(p.linkId, dek, jwk, ttlHours).then(() => undefined), toPanel);
    },

    async approveAsProvider(p: ProviderLinkView) {
      await run(() => approveSupportAsProvider(p.linkId, ttlHours).then(() => undefined), deps.reportError);
    },

    async revokeAsProvider(p: ProviderLinkView) {
      // No vault rotation, unlike the patient-side revoke: a provider owns nothing encrypted, and
      // support only ever held per-patient DEKs via separate patient grants, which are the patients'
      // to rotate.
      await run(() => revokeProvider(p.linkId).then(() => undefined), deps.reportError);
    },

    rotateVaultKey,

    reset() {
      open = false;
      providers = [];
      newProviderEmail = "";
      error = null;
    },
  };
}

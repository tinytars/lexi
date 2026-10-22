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
import type { ProviderKind } from "@tinytars/vault/stores";
import { grantProviderUntil } from "./access-request";

const defaultApi = {
  listMyProviders,
  lookupProvider,
  grantProvider,
  grantProviderUntil,
  revokeProvider,
  approveSupport,
  approveSupportAsProvider,
  getVaultPrincipals,
  stageVaultRotation,
  rotateVault,
};

export type VaultPrincipalsApi = typeof defaultApi;

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
  /**
   * Where a background load failure goes. `refreshQuietly` must not interrupt a boot, but "must not
   * block" was implemented as "is never seen": a 401, a 500 and an empty list were one observable, so
   * an owner whose pending-request badge silently never loaded had nothing to look at and neither did
   * we. Host-supplied because the sink is the app's (the host files it as a handled client error).
   */
  reportLoadFailure: (err: unknown) => void;
  /** The server calls, overridable so a test can pass fakes. Defaults to `@tinytars/vault`. */
  api?: Partial<VaultPrincipalsApi>;
}

export interface VaultPrincipals {
  readonly open: boolean;
  readonly providers: ProviderLinkView[];
  readonly busy: boolean;
  readonly error: string | null;
  /** Bound to the add-provider input. */
  newProviderEmail: string;

  /**
   * How long the access offered to THIS asker would last, in hours, with 0 meaning no end date.
   * Falls back to the default for their kind until the owner touches the control, so a row always
   * has an answer and the one they see is the one `approve` will send.
   */
  chosenHours(p: ProviderLinkView): number;
  setChosenHours(linkId: string, hours: number): void;
  /**
   * What the owner has changed but not yet acted on, for `Modal`'s dirty check. A plain object
   * rather than the `Map` this wants to be: that check is `JSON.stringify`, and a `Map` stringifies
   * to `{}` — so every unsent choice would read as no choice and close without warning.
   */
  readonly chosenSnapshot: Record<string, number>;

  /**
   * Everyone who has asked and not yet been answered, of either kind. What the patient's panel
   * iterates and what the sidebar badge counts.
   */
  readonly pendingRequests: ProviderLinkView[];
  /**
   * Pending SUPPORT requests alone. Still needed, and not a leftover: the clinician console lists
   * the support agents asking for its roster, where a patient's pending request has no meaning.
   */
  readonly pendingSupport: ProviderLinkView[];
  /** Who can actually read the record, right now. */
  readonly activeAccess: ProviderLinkView[];
  /**
   * Access that was granted and has run out. Still listed, because an owner who gave a clinician
   * thirty days should be able to see that it lapsed and renew it — a row that simply vanished
   * would be indistinguishable from one they revoked.
   */
  readonly endedAccess: ProviderLinkView[];
  /** Approved support agents, as the clinician console lists them. */
  readonly activeSupport: ProviderLinkView[];

  openPanel(): Promise<void>;
  closePanel(): void;
  /** Reloads the list without opening the panel. Non-fatal: an empty section beats a blocked boot. */
  refreshQuietly(): Promise<void>;
  addProvider(): Promise<void>;
  revoke(p: ProviderLinkView): Promise<void>;
  approve(p: ProviderLinkView): Promise<void>;
  /**
   * Re-expresses the grant with a new window: `ttlDays` days from now, or `null` for no end date.
   * One method and not three, because "Renew", "Extend 30 days", "Make ongoing" and "Set a 30-day
   * limit" are four labels over one act — the route writes status, expiry and consent together, so
   * restoring lapsed access and moving a live window are the same statement with a different number.
   */
  renew(p: ProviderLinkView, ttlDays: number | null): Promise<void>;
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
  const api = { ...defaultApi, ...deps.api };
  let open = $state(false);
  let providers = $state<ProviderLinkView[]>([]);
  let newProviderEmail = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  // One `$state(72)` used to serve every row AND the clinician console's own approvals, so choosing
  // a window for the second asker silently rewrote the first one's, and the number the owner read
  // beside one name was the number another name was granted. Hours rather than days because the
  // support windows this also serves are shorter than a day; 0 is no end date.
  const DEFAULT_HOURS: Record<ProviderKind, number> = { primary: 720, support: 72 };
  let chosen = $state<Record<string, number>>({});
  const chosenHours = (p: ProviderLinkView) => chosen[p.linkId] ?? DEFAULT_HOURS[p.kind];
  // A window the owner can still see is a window that has not run out: both ends of this comparison
  // are the same question the server asks in `getActiveProviderLink`, asked here only to decide what
  // to draw. An unparseable date is NaN and compares false, so a row with a broken expiry reads as
  // live rather than silently disappearing — the server is still the one refusing the read.
  const expired = (p: ProviderLinkView) => !!p.expiresAt && Date.parse(p.expiresAt) <= Date.now();
  // The grant route speaks days and the break-glass route speaks hours, so one of them converts.
  // It is this one, because the control the owner touches is shared between the two.
  const daysFromHours = (hours: number) => (hours === 0 ? null : hours / 24);

  // THE LINE THAT WAS WRONG, and what it cost. `activeAccess` was the negation of `pendingSupport`
  // — "everything that is not a pending support request" — which is the same set as "everything
  // answered" only while a pending request can only be support. The moment a clinician can ask, an
  // invited primary link falls into `activeAccess` and the patient's own privacy screen tells them
  // somebody can read their record who cannot, with a Revoke button and no Approve: no way to grant
  // the access it claims is already granted. So the test is `status`, which is the question actually
  // being asked, and `kind` is left to the two places that genuinely mean support.
  const pendingRequests = $derived(providers.filter((p) => p.status === "invited"));
  const pendingSupport = $derived(pendingRequests.filter((p) => p.kind === "support"));
  const activeAccess = $derived(providers.filter((p) => p.status === "active" && !expired(p)));
  const endedAccess = $derived(providers.filter((p) => p.status === "active" && expired(p)));
  const activeSupport = $derived(providers.filter((p) => p.kind === "support" && p.status === "active"));

  /** The busy/error/reload envelope every handler here shares. */
  async function run(body: () => Promise<void>, report: (m: string | null) => void): Promise<void> {
    busy = true;
    report(null);
    try {
      await body();
      providers = await api.listMyProviders();
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
    const principals = await api.getVaultPrincipals();
    const newDek = await generateDEK();
    // The blob goes to a NEW object, reserved here, and the envelope commit below doubles as the
    // pointer swap. This used to re-encrypt in place and commit the matching envelopes four round
    // trips later; anything that interrupted that window — a dropped connection, a closed lid
    // mid-revoke — left every principal holding an envelope for a key the ciphertext no longer used.
    // An interruption before the commit now leaves the old blob and the old envelopes still agreeing,
    // and the abandoned object is ciphertext under a key nobody kept.
    const newVaultId = await api.stageVaultRotation(principals.vaultId);
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
    await api.rotateVault({ vaultId: principals.vaultId, newVaultId, envelopes });
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
    chosenHours,
    setChosenHours(linkId: string, hours: number) {
      chosen[linkId] = hours;
    },
    get chosenSnapshot() {
      return chosen;
    },
    get pendingRequests() {
      return pendingRequests;
    },
    get pendingSupport() {
      return pendingSupport;
    },
    get activeAccess() {
      return activeAccess;
    },
    get endedAccess() {
      return endedAccess;
    },
    get activeSupport() {
      return activeSupport;
    },

    async openPanel() {
      open = true;
      error = null;
      try {
        providers = await api.listMyProviders();
      } catch (e) {
        error = (e as Error).message;
      }
    },

    closePanel() {
      open = false;
    },

    async refreshQuietly() {
      try {
        providers = await api.listMyProviders();
      } catch (e) {
        // Still non-fatal — the caller is a boot path and the panel stays empty — but no longer silent.
        deps.reportLoadFailure(e);
      }
    },

    async addProvider() {
      const emailInput = newProviderEmail.trim();
      const dek = deps.session.dek;
      if (!emailInput || !dek) return;
      busy = true;
      error = null;
      try {
        const provider = await api.lookupProvider(emailInput);
        // Not an exception, and deliberately not a reload either: a typo is an ordinary outcome, and
        // re-listing for it would be a round trip that changes nothing.
        if (!provider) {
          error = "No provider found with that email.";
          return;
        }
        // No duration: the route's own default applies. The number lives on the server because the
        // server computes the date, and a second copy here could only disagree with it.
        await api.grantProvider(dek, provider);
        newProviderEmail = "";
        providers = await api.listMyProviders();
      } catch (e) {
        error = (e as Error).message;
      } finally {
        busy = false;
      }
    },

    async revoke(p: ProviderLinkView) {
      await run(async () => {
        await api.revokeProvider(p.linkId);
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
      const hours = chosenHours(p);
      // Both branches wrap the owner's DEK to the asker's public key in this browser and differ in
      // what the server then records. Support goes through the audited break-glass route it has to
      // re-enter by; a clinician gets an ordinary provider link carrying the window just chosen.
      //
      // This used to say the split existed because an `expiresAt` written by `/api/support/approve`
      // is checked only by the support read path, so a clinician approved through it would hold a
      // link that reads as time-boxed and is in fact permanent. That was already false when it was
      // written: `getActiveProviderLink` refuses a lapsed link whatever its role, and every
      // non-owner read passes through it. The split is still right for the reason that survives —
      // break-glass is support's audited act, a clinician's access is the patient's own grant — but
      // the danger it named was the inverse of the real one, and believing it is why nothing ever
      // wrote an end date for a clinician at all.
      await run(
        () =>
          p.kind === "support"
            ? api.approveSupport(p.linkId, dek, jwk, hours).then(() => undefined)
            : api.grantProviderUntil(dek, { providerAccountId: p.providerAccountId, publicKeyJwk: jwk }, daysFromHours(hours)),
        toPanel,
      );
    },

    async renew(p: ProviderLinkView, ttlDays: number | null) {
      const dek = deps.session.dek;
      // The key is needed because a renewal re-wraps rather than just moving a date: /api/providers
      // lists it for every link that has not been revoked, which is every link this can be called on.
      if (!dek || !p.publicKeyJwk) return;
      const jwk = p.publicKeyJwk;
      await run(() => api.grantProviderUntil(dek, { providerAccountId: p.providerAccountId, publicKeyJwk: jwk }, ttlDays), toPanel);
    },

    async approveAsProvider(p: ProviderLinkView) {
      // Per asker, like the patient panel's: this console lists several support agents at once, and
      // the shared number meant answering the second one rewrote what the first was offered.
      await run(() => api.approveSupportAsProvider(p.linkId, chosenHours(p)).then(() => undefined), deps.reportError);
    },

    async revokeAsProvider(p: ProviderLinkView) {
      // No vault rotation, unlike the patient-side revoke: a provider owns nothing encrypted, and
      // support only ever held per-patient DEKs via separate patient grants, which are the patients'
      // to rotate.
      await run(() => api.revokeProvider(p.linkId).then(() => undefined), deps.reportError);
    },

    rotateVaultKey,

    reset() {
      open = false;
      providers = [];
      newProviderEmail = "";
      chosen = {};
      error = null;
    },
  };
}

// How a session starts, and whose record it is on.
//
// W76 — App.svelte's fifth and last controller extraction. This is the cluster that answers "who is
// signed in": the cold-load resume, the owner/provider/support routing that follows a login, and the
// clinician roster that a provider drills into. It had no unit test at all, and two of its rules are
// security properties rather than conveniences — a stored account key whose session has expired is
// DROPPED rather than kept, and the resume marker is only written once the key is actually stored, so
// a browser that refuses persistence does not advertise a resume it cannot perform.
//
// Same getter-parameterized factory shape as the other four. The vault itself stays with App, per
// vault-session.svelte.ts's own note: the key material's lifetime is the security property, and the
// plaintext record cannot outlive it because it cannot be re-read without one.

import type { VaultSession, VaultEntry } from "./vault-session.svelte";
import { getAccountKey, putAccountKey, clearAccountKey } from "../security/key-store";
import { unwrapDEKWithPrivateKey } from "../security/crypto";
import { b64ToBytes } from "./base64";
import { resumeSession, bootstrapGoogleSession, getMyAccount } from "./auth-client";
import { revokeProvider } from "./auth-grants";

/** W49 — non-sensitive flag marking that a session may be resumable on reload. */
export const RESUME_MARKER = "hd_resume";

export interface RosterPatient extends VaultEntry {
  /** W48 — the provider can DELETE /api/providers/{linkId} to drop this patient. */
  linkId: string;
  vaultId: string;
}

/** What a login, a resume or a recovery all hand back. */
export interface EnteredAccount {
  vaultId: string | null;
  r2Key: string | null;
  privateKey: CryptoKey;
  dek: CryptoKey | null;
  rotationPending?: boolean;
}

export interface RosterSessionDeps {
  session: VaultSession;
  reportError: (message: string | null) => void;
  /** The lock screen's fields, cleared the moment a session begins. */
  clearLoginForm: () => void;
  /** Owner path: decrypt and install the owner's own vault. App owns the decrypted record. */
  openOwnVault: (r2Key: string, dek: CryptoKey) => Promise<void>;
  /** Owner path, after the vault is open: the recovery-envelope backfill, account info, any re-key. */
  afterOwnerEnter: (rotationPending: boolean) => Promise<void>;
  /** A support provider gets the audited console; a clinician gets the roster and the refresh token. */
  beginSupportSession: () => Promise<void>;
  beginClinicianSession: () => Promise<void>;
  /** The drill-in: unwrap, decrypt, and move the app to this patient. One body, both consoles. */
  openPatientVault: (entry: VaultEntry, providerKey: CryptoKey) => Promise<void>;
  /** Drops the decrypted record. Paired with session.close(), which drops the key that made it. */
  closeVault: () => void;
  /** The roster-removal confirmation. Injected so the dialog stays the host's. */
  confirmRemoval: (label: string) => boolean;
}

export interface RosterSession {
  /** True for a clinician or support account — one without a vault of its own. */
  readonly isProvider: boolean;
  /** The clinician's roster. Empty in an owner session. */
  readonly patients: RosterPatient[];
  /** Who is being viewed, when a provider has drilled in. Null on one's own record. */
  readonly enteredPatient: { email: string | null; displayName: string } | null;
  /**
   * True while the cold-load resume is still deciding, so the lock screen does not flash. Starts
   * false and is raised by `bootResume` itself — synchronously, before its first await — so the host
   * has no window in which it must own a second copy of this flag. W76: it did own one, and that
   * copy was never lowered, leaving every reloaded page on "Restoring your session…" forever.
   */
  readonly resuming: boolean;

  /** Routes a login/resume/recovery result to the owner, clinician or support path. */
  enterAccount(r: EnteredAccount): Promise<void>;
  /** The cold-load resume, dispatched by the marker so we only probe when there is one. */
  bootResume(): Promise<void>;
  /** Stores the account key and marks the session resumable — in that order, and only in that order. */
  persistSessionKey(privateKey: CryptoKey): Promise<void>;
  loadPatients(): Promise<void>;
  removeFromRoster(p: RosterPatient): Promise<void>;
  /** The label a roster row shows, which is the email whenever the "name" is a signup placeholder. */
  label(p: RosterPatient): string;
  enterPatient(p: RosterPatient): Promise<void>;
  /** Leaves a patient's record without leaving the provider's session. */
  backToRoster(): void;
  /** Records who was entered. Called by the host once the vault is actually installed. */
  setEnteredPatient(who: { email: string | null; displayName: string } | null): void;
  reset(): void;
}

export function createRosterSession(deps: RosterSessionDeps): RosterSession {
  let isProvider = $state(false);
  let patients = $state<RosterPatient[]>([]);
  let enteredPatient = $state<{ email: string | null; displayName: string } | null>(null);
  let resuming = $state(false);

  async function loadPatients(): Promise<void> {
    const res = await fetch("/api/providers/patients", { cache: "no-store" });
    // A failed fetch leaves the previous roster standing rather than blanking it. A provider whose
    // network blipped keeps the list they were working from; an empty roster would read as "you have
    // no patients", which is a different and wrong statement.
    if (res.ok) patients = ((await res.json()).patients ?? []) as RosterPatient[];
  }

  async function enterAccount(r: EnteredAccount): Promise<void> {
    deps.clearLoginForm();
    if (r.vaultId && r.r2Key && r.dek) {
      deps.session.setOwnerKey(r.privateKey);
      isProvider = false;
      await deps.openOwnVault(r.r2Key, r.dek);
      await deps.afterOwnerEnter(r.rotationPending ?? false);
      return;
    }
    deps.session.setProviderKey(r.privateKey);
    isProvider = true;
    const acct = await getMyAccount();
    if (acct.providerKind === "support") await deps.beginSupportSession();
    else {
      await loadPatients();
      await deps.beginClinicianSession();
    }
  }

  /**
   * Password/passkey: the account private key is a non-extractable CryptoKey persisted in IndexedDB.
   * With a valid session, re-fetch the vault location and owner envelope, unwrap the DEK with the
   * stored key, and enter. A stored key whose session has expired is dropped, not kept — otherwise a
   * shared machine keeps a key for an account nobody is signed into any more.
   */
  async function resumeFromStoredKey(): Promise<boolean> {
    let storedKey: CryptoKey | null = null;
    try {
      storedKey = await getAccountKey();
    } catch {
      return false;
    }
    if (!storedKey) return false;
    const r = await resumeSession();
    if (!r) {
      try {
        await clearAccountKey();
      } catch {
        /* best-effort */
      }
      return false;
    }
    const dek = r.ownerEnvelope
      ? await unwrapDEKWithPrivateKey(b64ToBytes(r.ownerEnvelope.wrappedDEK), r.ownerEnvelope.ephemeralPublicKeyJwk, storedKey)
      : null;
    await enterAccount({ vaultId: r.vaultId, r2Key: r.r2Key, privateKey: storedKey, dek, rotationPending: r.rotationPending });
    return true;
  }

  /** Google: no client-held key (server custody, W45). A non-Google session 401s and stays locked. */
  async function resumeGoogle(): Promise<boolean> {
    try {
      await enterAccount(await bootstrapGoogleSession());
      return true;
    } catch {
      return false;
    }
  }

  return {
    get isProvider() {
      return isProvider;
    },
    get patients() {
      return patients;
    },
    get enteredPatient() {
      return enteredPatient;
    },
    get resuming() {
      return resuming;
    },

    enterAccount,
    loadPatients,

    async bootResume() {
      resuming = true;
      try {
        const marker = localStorage.getItem(RESUME_MARKER);
        if (marker === "key" && (await resumeFromStoredKey())) return;
        if (marker === "google" && (await resumeGoogle())) return;
        // Nothing resumed — clear the marker so the next load goes straight to the lock screen
        // instead of paying for a probe that already failed once.
        localStorage.removeItem(RESUME_MARKER);
      } catch {
        localStorage.removeItem(RESUME_MARKER);
      } finally {
        resuming = false;
      }
    },

    async persistSessionKey(privateKey: CryptoKey) {
      try {
        await putAccountKey(privateKey);
        // Only once the key is genuinely stored. Setting the marker first would promise a resume that
        // private browsing cannot deliver, and the next load would probe, fail, and clear it anyway.
        localStorage.setItem(RESUME_MARKER, "key");
      } catch {
        /* persistence unavailable; the session still works this page, it just re-auths on refresh */
      }
    },

    // W48 — dropping a patient deletes the provider's envelope; the patient must re-grant to restore
    // access. The patient's own vault is untouched.
    async removeFromRoster(p: RosterPatient) {
      if (!deps.confirmRemoval(p.displayName)) return;
      deps.reportError(null);
      try {
        await revokeProvider(p.linkId);
        await loadPatients();
      } catch (e) {
        deps.reportError((e as Error).message);
      }
    },

    // W50 — names are auto-derived at signup (password/passkey → the email local-part;
    // Google-without-name → "New member"), so when the "name" is really a placeholder we show the
    // full email, which actually tells two patients apart.
    label(p: RosterPatient): string {
      const name = p.displayName?.trim() ?? "";
      if (!p.email) return name;
      // Exact match against the verbatim local-part — that is the untouched auto value. A
      // capitalised or edited name like "Liz" is a real, human-set one and stands.
      const localPart = p.email.split("@")[0];
      return name === "" || name === "New member" || name === localPart ? p.email : name;
    },

    async enterPatient(p: RosterPatient) {
      const providerKey = deps.session.providerKey;
      if (!providerKey) return;
      deps.reportError(null);
      try {
        await deps.openPatientVault(p, providerKey);
      } catch (e) {
        deps.reportError((e as Error).message);
      }
    },

    backToRoster() {
      deps.closeVault();
      deps.session.close();
      enteredPatient = null;
      // The roster, the provider key and the provider flag all stay — this provider is still signed in
      // and still needs their key to open the next patient.
    },

    setEnteredPatient(who) {
      enteredPatient = who;
    },

    reset() {
      isProvider = false;
      patients = [];
      enteredPatient = null;
    },
  };
}

// The Account panel: who this account is, and every way there is into it.
//
// App's fourth controller extraction. Adding and removing sign-in methods is the only
// cluster in the component that can lock a person out of their own health record, and the rule that
// stops it — never remove the last way in — lived in a `disabled` attribute on a button. The server
// enforces it too (functions/api/account/methods.ts:126), so this was never a hole; it was an
// invariant with no name and no test, expressed as a UI affordance. It has one of each now.
//
// Same getter-parameterized factory shape as vault-principals.svelte.ts, recovery-controller.svelte.ts
// and support-access.svelte.ts. What stays with App is what App owns: the vault principals and access
// events the owner-only blocks render, and the unit system every tab reads.

import { getMyAccount, addPasskeyMethod, addGoogleMethod } from "../security/auth-client";
import { listMethods, updateProfile, addPasswordMethod, removeMethod, type LoginMethod } from "../security/auth-recovery";

export type RemovableMethod = "password" | "passkey" | "google";

export interface AccountInfo {
  email: string | null;
  displayName: string;
  emailConfirmed: boolean;
}

export interface AccountMethodsDeps {
  /**
   * The in-memory account private key — `session.ownerKey ?? session.providerKey`, read fresh because
   * a resume replaces it. Every add re-wraps it, which is why extractability decides the whole panel.
   */
  getPrivateKey: () => CryptoKey | null;
  /** A provider session has no vault of its own, so it gets no recovery or access-log blocks. */
  isProviderSession: () => boolean;
  /** The unit system rides on the account payload but belongs to the shell — every tab reads it. */
  applyUnitSystem: (u: "metric" | "imperial") => void;
  /** Vault principals + access events. App's, because App owns the recovery controller they feed. */
  loadOwnerBlocks: () => Promise<void>;
}

export interface AccountMethods {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly info: AccountInfo | null;
  readonly methods: LoginMethod[];
  /** The verify-email banner's transient note. The persistent state is `info.emailConfirmed`. */
  emailVerifyNote: "ok" | "invalid" | "sent" | null;
  /** Bound to the profile form. */
  editEmail: string;
  editDisplayName: string;
  /** Bound to the add-password field. */
  newPassword: string;

  /** Methods that can actually sign someone in — recovery is a way back, not a way in. */
  readonly loginMethods: LoginMethod[];
  readonly hasPassword: boolean;
  readonly hasPasskey: boolean;
  readonly hasGoogle: boolean;
  readonly hasRecovery: boolean;
  /**
   * Why this method cannot be removed, or null when it can. A string rather than a boolean because
   * the button needs the sentence for its tooltip, and one source beats a parallel condition.
   */
  removeBlockedReason(method: RemovableMethod): string | null;

  /**
   * After a plain-refresh resume the account key is the non-extractable copy restored from
   * IndexedDB, so it cannot be re-wrapped under a new KEK. Adding or changing a login method needs a
   * fresh sign-in; everything else works unchanged. Public because the recovery ladder re-wraps too.
   */
  ensureExtractableKey(): CryptoKey | null;

  openPanel(): Promise<void>;
  closePanel(): void;
  /** Re-reads account and methods from the server. Every mutation below ends here. */
  refresh(): Promise<void>;
  resendVerification(): Promise<void>;
  saveProfile(): Promise<void>;
  addPassword(): Promise<void>;
  addPasskey(): Promise<void>;
  remove(method: RemovableMethod): Promise<void>;
  /** Runs the Google link popup and finishes the link when it reports back. */
  connectGoogle(): void;
  /** Reports through this panel's error line — the popup's failures are the panel's. */
  setError(message: string | null): void;
  setBusy(busy: boolean): void;
  reset(): void;
}

export function createAccountMethods(deps: AccountMethodsDeps): AccountMethods {
  let open = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let info = $state<AccountInfo | null>(null);
  let methods = $state<LoginMethod[]>([]);
  let editEmail = $state("");
  let editDisplayName = $state("");
  let newPassword = $state("");
  let emailVerifyNote = $state<"ok" | "invalid" | "sent" | null>(null);

  const loginMethods = $derived(methods.filter((m) => !m.isRecovery && m.method !== "recovery"));
  const hasPassword = $derived(loginMethods.some((m) => m.method === "password"));
  const hasPasskey = $derived(loginMethods.some((m) => m.method === "passkey"));
  const hasGoogle = $derived(loginMethods.some((m) => m.method === "google"));
  const hasRecovery = $derived(methods.some((m) => m.isRecovery || m.method === "recovery"));

  function ensureExtractableKey(): CryptoKey | null {
    const pk = deps.getPrivateKey();
    if (!pk) return null;
    if (!pk.extractable) {
      error = "For your security, sign out and sign in again to add or change a login method.";
      return null;
    }
    return pk;
  }

  async function refresh(): Promise<void> {
    const [account, list] = await Promise.all([getMyAccount(), listMethods()]);
    info = { email: account.email, displayName: account.displayName, emailConfirmed: account.emailConfirmed };
    methods = list;
    deps.applyUnitSystem(account.unitSystem ?? "imperial");
  }

  /** The busy/error envelope every mutation shares. Each one ends by re-reading the server. */
  async function mutate(body: () => Promise<void>): Promise<void> {
    busy = true;
    try {
      await body();
      await refresh();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  function removeBlockedReason(method: RemovableMethod): string | null {
    if (!loginMethods.some((m) => m.method === method)) return null;
    // The server refuses this too. Both are the invariant: the server so a crafted request cannot
    // do it, and here so the person is told before they try rather than after.
    return loginMethods.length <= 1 ? "You can't remove your only sign-in method" : null;
  }

  return {
    get open() {
      return open;
    },
    get busy() {
      return busy;
    },
    get error() {
      return error;
    },
    get info() {
      return info;
    },
    get methods() {
      return methods;
    },
    get emailVerifyNote() {
      return emailVerifyNote;
    },
    set emailVerifyNote(v: "ok" | "invalid" | "sent" | null) {
      emailVerifyNote = v;
    },
    get editEmail() {
      return editEmail;
    },
    set editEmail(v: string) {
      editEmail = v;
    },
    get editDisplayName() {
      return editDisplayName;
    },
    set editDisplayName(v: string) {
      editDisplayName = v;
    },
    get newPassword() {
      return newPassword;
    },
    set newPassword(v: string) {
      newPassword = v;
    },
    get loginMethods() {
      return loginMethods;
    },
    get hasPassword() {
      return hasPassword;
    },
    get hasPasskey() {
      return hasPasskey;
    },
    get hasGoogle() {
      return hasGoogle;
    },
    get hasRecovery() {
      return hasRecovery;
    },

    removeBlockedReason,
    ensureExtractableKey,

    async openPanel() {
      open = true;
      error = null;
      try {
        const [account, list] = await Promise.all([getMyAccount(), listMethods()]);
        info = { email: account.email, displayName: account.displayName, emailConfirmed: account.emailConfirmed };
        methods = list;
        editEmail = account.email ?? "";
        editDisplayName = account.displayName;
        // The recovery and access-log blocks only apply to an owned vault; a provider
        // session has none, and asking for principals it does not have is a 403 on every open.
        if (!deps.isProviderSession()) await deps.loadOwnerBlocks();
      } catch (e) {
        error = (e as Error).message;
      }
    },

    closePanel() {
      open = false;
    },

    refresh,

    // Best-effort by design: verification never gates the app, so a failure to send is not
    // worth a red line across a panel the person opened to do something else.
    async resendVerification() {
      try {
        await fetch("/api/account/email/send-verification", { method: "POST" });
        emailVerifyNote = "sent";
      } catch {
        /* best-effort */
      }
    },

    async saveProfile() {
      error = null;
      await mutate(() => updateProfile({ email: editEmail.trim() || undefined, displayName: editDisplayName.trim() || undefined }));
    },

    async addPassword() {
      if (!newPassword) return;
      error = null;
      const pk = ensureExtractableKey();
      if (!pk) return;
      const password = newPassword;
      await mutate(async () => {
        await addPasswordMethod(pk, password);
        // Cleared inside the try: a rejected password (too short, step-up refused) must stay in the
        // field, or the retry is a re-entry of something the person already typed once.
        newPassword = "";
      });
    },

    async addPasskey() {
      error = null;
      const pk = ensureExtractableKey();
      if (!pk) return;
      await mutate(() => addPasskeyMethod(pk));
    },

    async remove(method: RemovableMethod) {
      error = null;
      const blocked = removeBlockedReason(method);
      if (blocked) {
        error = blocked;
        return;
      }
      await mutate(() => removeMethod(method));
    },

    // OAuth runs in a POPUP so this SPA (and the in-memory key the server needs to wrap)
    // survives; the popup postMessages back once the signed link cookie is set, and only then do we
    // hand the server the private key to finish the link.
    connectGoogle() {
      error = null;
      const pk = ensureExtractableKey();
      if (!pk) return;
      const popup = window.open("/api/auth/google/start?mode=link", "hd-google", "popup,width=520,height=640");
      if (!popup) {
        error = "Enable pop-ups for this site to connect Google.";
        return;
      }
      const onMessage = async (ev: MessageEvent) => {
        if (ev.origin !== window.location.origin) return;
        const data = ev.data as { type?: string; error?: string };
        if (data?.type !== "hd-google-linked" && data?.type !== "hd-google-error") return;
        window.removeEventListener("message", onMessage);
        if (data.type === "hd-google-error") {
          error =
            data.error === "linked_elsewhere"
              ? "That Google account is already linked to another account."
              : data.error === "not_signed_in"
                ? "Your session expired — sign in again."
                : "Google sign-in failed.";
          return;
        }
        await mutate(() => addGoogleMethod(pk));
      };
      window.addEventListener("message", onMessage);
    },

    setError(message: string | null) {
      error = message;
    },

    setBusy(b: boolean) {
      busy = b;
    },

    reset() {
      open = false;
      busy = false;
      error = null;
      info = null;
      methods = [];
      editEmail = "";
      editDisplayName = "";
      newPassword = "";
    },
  };
}

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

import { getMyAccount, addPasskeyMethod, addGoogleMethod } from "@tinytars/vault/auth-client";
import { listMethods, updateProfile, addPasswordMethod, removeMethod, type LoginMethod } from "@tinytars/vault/auth-recovery";

export type RemovableMethod = "password" | "passkey" | "google";

/**
 * Which control a message belongs to, so the panel can render it beside that control. Before this,
 * the panel kept ONE message and the host rendered it once at the foot of the modal, below the whole
 * privacy block — so a button at the top failed and the reason appeared hundreds of pixels away, and
 * a second attempt on a different button overwrote the first one's explanation. Read as "these
 * buttons are not doing anything", which was the correct reading of what was shown.
 */
export type AccountAction = "profile" | "password" | "passkey" | "google" | "remove";

export interface AccountInfo {
  email: string | null;
  displayName: string;
  emailConfirmed: boolean;
}

const defaultApi = {
  getMyAccount,
  listMethods,
  updateProfile,
  addPasswordMethod,
  addPasskeyMethod,
  addGoogleMethod,
  removeMethod,
  // Wrapped, because a bare `fetch` invoked as `api.fetch` throws "Illegal invocation" in browsers.
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
};

export type AccountMethodsApi = typeof defaultApi;

export interface AccountMethodsDeps {
  /**
   * The in-memory account private key — `session.ownerKey ?? session.providerKey`, read fresh because
   * a resume replaces it. Every add re-wraps it, which is why extractability decides the whole panel.
   */
  getPrivateKey: () => CryptoKey | null;
  /**
   * The host app's own name, used in the panel's messages. It is a dependency rather than a
   * constant because this package ships the shape of a brand and none of its values
   * (`neutrality.test.ts`) — and because the messages have to say WHOSE password is being asked
   * for: "sign out and sign in again" is ambiguous on a screen that also has a Google button, and
   * the person reading it has two accounts in play.
   */
  productName: string;
  /** A provider session has no vault of its own, so it gets no recovery or access-log blocks. */
  isProviderSession: () => boolean;
  /** The unit system rides on the account payload but belongs to the shell — every tab reads it. */
  applyUnitSystem: (u: "metric" | "imperial") => void;
  /** Vault principals + access events. App's, because App owns the recovery controller they feed. */
  loadOwnerBlocks: () => Promise<void>;
  /** The server calls, overridable so a test can pass fakes. Defaults to `@tinytars/vault`. */
  api?: Partial<AccountMethodsApi>;
}

export interface AccountMethods {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  /** Which control `error` belongs to; `null` means the panel as a whole. See `AccountAction`. */
  readonly errorFor: AccountAction | null;
  /** The confirmation line for the action that just succeeded — success had no signal at all before. */
  readonly done: string | null;
  readonly doneFor: AccountAction | null;
  /** Which action is in flight, so the pressed control can say so rather than only go grey. */
  readonly pending: AccountAction | null;
  readonly info: AccountInfo | null;
  readonly methods: LoginMethod[];
  /** The verify-email banner's transient note. The persistent state is `info.emailConfirmed`. */
  emailVerifyNote: "ok" | "invalid" | "sent" | null;
  /** Bound to the profile form. */
  editEmail: string;
  editDisplayName: string;
  /** Bound to the add-password field. */
  newPassword: string;
  /**
   * Bound to the step-up field. Adding Google, a passkey or a password to an account that ALREADY has
   * a password requires proving that password (`functions/_lib/step-up.ts`, W73) — and until this
   * field existed the panel sent no proof, so all three calls returned 401 `step_up_required` on
   * every account with a password, which on production is every account. The panel then displayed the
   * server's "enter your current password to add a sign-in method" at the bottom of the modal, next to
   * no password field, because there was none. This is the field the server has been asking for.
   */
  currentPassword: string;
  /** Whether this account has a password to be challenged — i.e. whether the field above applies. */
  readonly stepUpNeeded: boolean;
  /** When the recovery code was generated, per the server, or null if there is none. */
  readonly recoverySetAt: string | null;

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
  ensureExtractableKey(action?: AccountAction | null): CryptoKey | null;

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

/**
 * The browser's own passkey failures arrive as a DOMException written for a specification reader:
 * one shown to a person on 2026-10-17 ended "See:
 * https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client." Translate by `name`, which
 * is the stable part of a DOMException, and pass anything else through untouched — a message from
 * the server is already a sentence meant for a person (the host's passkey routes classify their own
 * failures), and rewriting it here would throw that away.
 */
export function passkeyFailureMessage(error: unknown, productName: string): string {
  const err = error as { name?: string; message?: string } | null;
  switch (err?.name) {
    case "NotAllowedError":
      // The one the spec deliberately makes ambiguous: dismissed, timed out, or no device offered.
      return "Your device did not confirm the passkey — the prompt was dismissed, or it timed out. Try again and approve it on your device.";
    case "InvalidStateError":
      return "This device already holds a passkey for this account.";
    case "SecurityError":
      return `Passkeys cannot be used at this web address, so ${productName} could not create one here.`;
    case "NotSupportedError":
      return "This device cannot create a passkey. Your password still works, and a recovery code is the backup.";
    case "AbortError":
      return "The passkey request was cancelled. Try again when you are ready.";
    default:
      return err?.message || "Adding a passkey did not work. Nothing changed.";
  }
}

export function createAccountMethods(deps: AccountMethodsDeps): AccountMethods {
  const api = { ...defaultApi, ...deps.api };
  let open = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let info = $state<AccountInfo | null>(null);
  let methods = $state<LoginMethod[]>([]);
  let editEmail = $state("");
  let editDisplayName = $state("");
  let newPassword = $state("");
  let currentPassword = $state("");
  let emailVerifyNote = $state<"ok" | "invalid" | "sent" | null>(null);
  let errorFor = $state<AccountAction | null>(null);
  let done = $state<string | null>(null);
  let doneFor = $state<AccountAction | null>(null);
  let pending = $state<AccountAction | null>(null);

  const loginMethods = $derived(methods.filter((m) => !m.isRecovery && m.method !== "recovery"));
  const hasPassword = $derived(loginMethods.some((m) => m.method === "password"));
  const hasPasskey = $derived(loginMethods.some((m) => m.method === "passkey"));
  const hasGoogle = $derived(loginMethods.some((m) => m.method === "google"));
  const hasRecovery = $derived(methods.some((m) => m.isRecovery || m.method === "recovery"));
  const recoverySetAt = $derived(methods.find((m) => m.isRecovery || m.method === "recovery")?.createdAt ?? null);
  // The server challenges a password when there is one and cannot challenge anything when there is
  // not (step-up.ts states both halves), so this is the client's half of the same rule rather than a
  // guess at it: ask for the proof exactly when the server will require it.
  const stepUpNeeded = $derived(hasPassword);

  function ensureExtractableKey(action: AccountAction | null = null): CryptoKey | null {
    const pk = deps.getPrivateKey();
    if (!pk) {
      // This branch used to `return null` with no message set, which is a button that does nothing
      // and says nothing. A missing key handle and a non-extractable one need different advice, so
      // they get different sentences rather than one that covers neither.
      error = `Your sign-in key isn't loaded in this tab. Sign out of ${deps.productName} and sign in again, then try this.`;
      errorFor = action;
      return null;
    }
    if (!pk.extractable) {
      error = `For your security, sign out of ${deps.productName} and sign in again to add or change a login method.`;
      errorFor = action;
      return null;
    }
    return pk;
  }

  /** The step-up proof, or undefined when there is nothing to prove. Spent on success, never reused. */
  function stepUp(): { currentPassword?: string; email?: string } {
    if (!stepUpNeeded || !currentPassword) return {};
    return { currentPassword, email: info?.email ?? undefined };
  }

  async function refresh(): Promise<void> {
    const [account, list] = await Promise.all([api.getMyAccount(), api.listMethods()]);
    info = { email: account.email, displayName: account.displayName, emailConfirmed: account.emailConfirmed };
    methods = list;
    deps.applyUnitSystem(account.unitSystem ?? "imperial");
  }

  /** The busy/error envelope every mutation shares. Each one ends by re-reading the server. */
  async function mutate(action: AccountAction, succeeded: string, body: () => Promise<void>): Promise<void> {
    busy = true;
    pending = action;
    error = null;
    errorFor = null;
    done = null;
    doneFor = null;
    try {
      await body();
      // `refresh()` before the confirmation, deliberately: the line claims what the SERVER now holds,
      // so it is only said once the server has been re-read. A success message written from the fact
      // that a request did not throw is the same unearned confidence as a button whose verb flips.
      await refresh();
      done = succeeded;
      doneFor = action;
      // The proof is spent. Leaving it in the field would make the next add succeed without the
      // person being present, which is the whole thing step-up exists to prevent.
      currentPassword = "";
    } catch (e) {
      error = (e as Error).message;
      errorFor = action;
    } finally {
      busy = false;
      pending = null;
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
    get errorFor() {
      return errorFor;
    },
    get done() {
      return done;
    },
    get doneFor() {
      return doneFor;
    },
    get pending() {
      return pending;
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
    get currentPassword() {
      return currentPassword;
    },
    set currentPassword(v: string) {
      currentPassword = v;
    },
    get stepUpNeeded() {
      return stepUpNeeded;
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
    get recoverySetAt() {
      return recoverySetAt;
    },

    removeBlockedReason,
    ensureExtractableKey,

    async openPanel() {
      open = true;
      error = null;
      errorFor = null;
      done = null;
      doneFor = null;
      currentPassword = "";
      try {
        const [account, list] = await Promise.all([api.getMyAccount(), api.listMethods()]);
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
        await api.fetch("/api/account/email/send-verification", { method: "POST" });
        emailVerifyNote = "sent";
      } catch {
        /* best-effort */
      }
    },

    async saveProfile() {
      await mutate("profile", "Profile saved.", () =>
        api.updateProfile({ email: editEmail.trim() || undefined, displayName: editDisplayName.trim() || undefined }),
      );
    },

    async addPassword() {
      if (!newPassword) return;
      const pk = ensureExtractableKey("password");
      if (!pk) return;
      const password = newPassword;
      const { currentPassword: cur, email } = stepUp();
      await mutate("password", `Password added — you can sign in to ${deps.productName} with it.`, async () => {
        await api.addPasswordMethod(pk, password, cur, email);
        // Cleared inside the try: a rejected password (too short, step-up refused) must stay in the
        // field, or the retry is a re-entry of something the person already typed once.
        newPassword = "";
      });
    },

    async addPasskey() {
      const pk = ensureExtractableKey("passkey");
      if (!pk) return;
      const { currentPassword: cur, email } = stepUp();
      await mutate("passkey", `Passkey added — you can sign in to ${deps.productName} with it.`, async () => {
        try {
          await api.addPasskeyMethod(pk, cur, email);
        } catch (e) {
          // mutate() shows `message` verbatim, which for a browser ceremony is a sentence about the
          // specification rather than about the person's device.
          throw new Error(passkeyFailureMessage(e, deps.productName));
        }
      });
    },

    async remove(method: RemovableMethod) {
      const blocked = removeBlockedReason(method);
      if (blocked) {
        error = blocked;
        errorFor = "remove";
        return;
      }
      await mutate("remove", "Sign-in method removed.", () => api.removeMethod(method));
    },

    // OAuth runs in a POPUP so this SPA (and the in-memory key the server needs to wrap)
    // survives; the popup postMessages back once the signed link cookie is set, and only then do we
    // hand the server the private key to finish the link.
    connectGoogle() {
      error = null;
      errorFor = null;
      done = null;
      doneFor = null;
      const pk = ensureExtractableKey("google");
      if (!pk) return;
      // Captured now, not when the popup reports back: the panel is live while Google's window is
      // open and the field is the person's to edit.
      const { currentPassword: cur, email } = stepUp();
      const popup = window.open("/api/auth/google/start?mode=link", "hd-google", "popup,width=520,height=640");
      if (!popup) {
        error = "Enable pop-ups for this site to connect Google.";
        errorFor = "google";
        return;
      }
      // Held across the whole trip to Google and back. Without it the panel looked idle for as long
      // as the person spent in Google's window, which is most of the time this action takes.
      busy = true;
      pending = "google";
      let settled = false;
      // Assigned below rather than closed over: `finish` is the only thing that clears it, and a
      // `const` declared after `finish` would be read before its initializer on a lint pass.
      let watch = 0;
      const finish = () => {
        settled = true;
        window.removeEventListener("message", onMessage);
        window.clearInterval(watch);
      };
      // Closing Google's window is a third outcome and it posts no message, so polling is the only
      // thing that can see it. Without this the panel stayed "Waiting for Google…" for ever.
      watch = window.setInterval(() => {
        if (settled || !popup.closed) return;
        finish();
        busy = false;
        pending = null;
        error = "Google's window closed before the connection finished. Try Connect Google again.";
        errorFor = "google";
      }, 500);
      const onMessage = async (ev: MessageEvent) => {
        if (ev.origin !== window.location.origin) return;
        const data = ev.data as { type?: string; error?: string };
        if (data?.type !== "hd-google-linked" && data?.type !== "hd-google-error") return;
        finish();
        if (data.type === "hd-google-error") {
          busy = false;
          pending = null;
          error =
            data.error === "linked_elsewhere"
              ? `That Google account is already connected to a different ${deps.productName} account.`
              : data.error === "not_signed_in"
                ? `Your ${deps.productName} session expired — sign in to ${deps.productName} again.`
                : "Google sign-in failed.";
          errorFor = "google";
          return;
        }
        // Google has verified who they are; the link itself still has to be written, and THAT is the
        // step that was failing silently. `mutate` owns busy/pending from here.
        await mutate("google", `Google connected — you can sign in to ${deps.productName} with Google.`, () =>
          api.addGoogleMethod(pk, cur, email),
        );
      };
      window.addEventListener("message", onMessage);
    },

    setError(message: string | null) {
      error = message;
      errorFor = null;
    },

    setBusy(b: boolean) {
      busy = b;
    },

    reset() {
      open = false;
      busy = false;
      error = null;
      errorFor = null;
      done = null;
      doneFor = null;
      pending = null;
      info = null;
      methods = [];
      editEmail = "";
      editDisplayName = "";
      newPassword = "";
      currentPassword = "";
    },
  };
}

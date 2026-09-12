// Getting back in: the four ways a person who cannot sign in ends up signed in again, and the one
// way they give that up on purpose.
//
// App's second controller extraction, and the one with the least test cover behind it. This
// recovery ladder was built first, with its server-side attempt cap fixed afterward, but the
// browser half had no unit test at all: which code kind is in play, what is shown once and never
// again, and what is left behind when a step fails. Those are state questions, and an e2e that
// drives the happy path cannot ask them.
//
// Same getter-parameterized factory shape as vault-principals.svelte.ts and the other controllers in
// this package. What stays with App is what App owns: the lock screen's email field, the account private key, and
// what a successful recovery does next (enter the account, persist the key). Two of the five handlers
// report through panels this module does not own — the Account modal's busy/error line and the lock
// screen's — so both are injected rather than duplicated here.

import type { VaultSession } from "./vault-session.svelte";
import {
  detectRecoveryKind,
  issueRecoveryCode,
  recoverAccount,
  redeemRecoveryCode,
  regenerateRecoveryCode,
  revokeRecoveryEnvelope,
} from "@tinytars/vault/auth-recovery";

/**
 * The minimum a roster row must carry to have a code issued for it. Structural, and the controller is
 * generic over it, so the host keeps its own richer row type (and its label function) without this
 * module importing the roster's shape.
 */
export interface RecoveryPatient {
  ownerAccountId: string;
  envelope: { wrappedDEK: string; ephemeralPublicKeyJwk: JsonWebKey };
}

/** What both recovery paths hand back; the shape `enterAccount` takes. */
export interface RecoveredSession {
  vaultId: string | null;
  r2Key: string | null;
  privateKey: CryptoKey;
  dek: CryptoKey | null;
  rotationPending?: boolean;
}

export interface RecoveryControllerDeps {
  /** The unlocked-session key material; `providerKey` is what authorizes issuing a code. */
  session: VaultSession;
  /** The lock screen's email field, read fresh — `enterAccount` clears it, so it must never be captured. */
  getEmail: () => string;
  /**
   * The account private key, or null with the "sign in again" message already posted. Regenerating a
   * recovery code needs an EXTRACTABLE key, which a resumed session may not have; App owns that check
   * because it owns the key.
   */
  ensureExtractableKey: () => CryptoKey | null;
  /** Re-reads the method list so the new recovery credential appears. App owns the Account modal. */
  refreshAccount: () => Promise<void>;
  setAccountBusy: (busy: boolean) => void;
  reportAccountError: (message: string | null) => void;
  /** The lock screen's busy flag and shared error line. */
  setUnlocking: (busy: boolean) => void;
  reportError: (message: string | null) => void;
  /** Enter the account and persist the key so the session survives a refresh. App owns both. */
  enterRecovered: (r: RecoveredSession) => Promise<void>;
}

export interface RecoveryController<P extends RecoveryPatient = RecoveryPatient> {
  /** The roster row whose one-time code dialog is open, or null when it is closed. */
  readonly issuedFor: P | null;
  readonly issuedCode: string | null;
  readonly issuedExpiresAt: string | null;
  readonly issuing: boolean;
  readonly issueError: string | null;

  /** Lock screen: recovery form shown instead of sign-in. */
  recoverMode: boolean;
  codeInput: string;
  newPassword: string;
  /**
   * Which ladder rung `codeInput` currently looks like: "code" is the patient's own recovery code,
   * "grant" is the one-time code a clinician reads to a patient who has lost theirs. Read off the
   * pasted/typed string's shape (`detectRecoveryKind`) — the two never collide by construction, so
   * there is nothing for the caller to pick.
   */
  readonly kind: "code" | "grant";

  /** The freshly minted recovery code, shown once in the Account modal and never fetched again. */
  readonly regeneratedCode: string | null;
  /** Whether the org still holds a recovery envelope for this vault, per the server. */
  readonly orgHeld: boolean;
  readonly orgRevokedAt: string | null;
  /** The two-step confirm on removing the org recovery key. */
  revokeConfirm: boolean;
  /** Dismissed for this session only — the nudge is per-session, not a stored preference. */
  nudgeDismissed: boolean;

  /** Provider action: mint a one-time code to read to a locked-out patient. */
  issueForPatient(p: P): Promise<void>;
  closeIssueDialog(): void;
  /** Mint a replacement recovery code for one's own account. */
  regenerate(): Promise<void>;
  /** Lock screen: redeem whichever code kind is selected, then enter. */
  recover(): Promise<void>;
  /** Give up org recovery: from here the password is the only key to the record. */
  revokeOrgKey(): Promise<void>;
  /** Adopt the server's answer about the org envelope. Called when the Account modal loads. */
  applyPrincipals(p: { envelopePrincipalIds: string[]; orgAccountId: string; orgRecoveryRevokedAt: string | null }): void;
  /**
   * Closing the Account modal drops the once-shown code and rearms the revoke confirm — but leaves the
   * lock-screen fields alone, which is why this is not `reset()`. Reopening the modal must not present
   * a half-pressed "Yes, remove it", and the code is unrecoverable anyway once the modal is gone.
   */
  closeAccountBlocks(): void;
  /** Clears everything on sign-out. */
  reset(): void;
}

export function createRecoveryController<P extends RecoveryPatient = RecoveryPatient>(
  deps: RecoveryControllerDeps,
): RecoveryController<P> {
  let issuedFor = $state<P | null>(null);
  let issuedCode = $state<string | null>(null);
  let issuedExpiresAt = $state<string | null>(null);
  let issuing = $state(false);
  let issueError = $state<string | null>(null);

  let recoverMode = $state(false);
  let codeInput = $state("");
  let newPassword = $state("");

  let regeneratedCode = $state<string | null>(null);
  let orgHeld = $state(false);
  let orgRevokedAt = $state<string | null>(null);
  let revokeConfirm = $state(false);
  let nudgeDismissed = $state(false);

  /** The Account modal's busy/error envelope, whose line belongs to App. */
  async function inAccount(body: () => Promise<void>): Promise<void> {
    deps.setAccountBusy(true);
    try {
      await body();
    } catch (e) {
      deps.reportAccountError((e as Error).message);
    } finally {
      deps.setAccountBusy(false);
    }
  }

  return {
    get issuedFor() {
      return issuedFor;
    },
    get issuedCode() {
      return issuedCode;
    },
    get issuedExpiresAt() {
      return issuedExpiresAt;
    },
    get issuing() {
      return issuing;
    },
    get issueError() {
      return issueError;
    },
    get recoverMode() {
      return recoverMode;
    },
    set recoverMode(v: boolean) {
      recoverMode = v;
    },
    get codeInput() {
      return codeInput;
    },
    set codeInput(v: string) {
      codeInput = v;
    },
    get newPassword() {
      return newPassword;
    },
    set newPassword(v: string) {
      newPassword = v;
    },
    get kind() {
      return detectRecoveryKind(codeInput);
    },
    get regeneratedCode() {
      return regeneratedCode;
    },
    get orgHeld() {
      return orgHeld;
    },
    get orgRevokedAt() {
      return orgRevokedAt;
    },
    get revokeConfirm() {
      return revokeConfirm;
    },
    set revokeConfirm(v: boolean) {
      revokeConfirm = v;
    },
    get nudgeDismissed() {
      return nudgeDismissed;
    },
    set nudgeDismissed(v: boolean) {
      nudgeDismissed = v;
    },

    async issueForPatient(p: P) {
      if (!deps.session.providerKey) return;
      issuedFor = p;
      issuedCode = null;
      issuedExpiresAt = null;
      issueError = null;
      issuing = true;
      try {
        const r = await issueRecoveryCode(p.ownerAccountId, p.envelope, deps.session.providerKey);
        issuedCode = r.code;
        issuedExpiresAt = r.expiresAt;
      } catch (e) {
        issueError = (e as Error).message;
      } finally {
        issuing = false;
      }
    },

    closeIssueDialog() {
      // Cleared on close, not merely hidden: the code is shown once, and leaving it in component state
      // would keep it alive in memory for the rest of the session for no reason.
      issuedFor = null;
      issuedCode = null;
      issuedExpiresAt = null;
      issueError = null;
    },

    async regenerate() {
      deps.reportAccountError(null);
      const pk = deps.ensureExtractableKey();
      if (!pk) return;
      await inAccount(async () => {
        regeneratedCode = await regenerateRecoveryCode(pk);
        await deps.refreshAccount();
      });
    },

    async recover() {
      const email = deps.getEmail();
      if (!email || !codeInput.trim()) return;
      deps.setUnlocking(true);
      deps.reportError(null);
      try {
        const r =
          detectRecoveryKind(codeInput) === "grant"
            ? await redeemRecoveryCode(email, codeInput.trim(), newPassword)
            : await recoverAccount(email, codeInput.trim(), newPassword);
        await deps.enterRecovered(r);
        // Only on success: a failed attempt keeps the typed code, because the usual failure is a
        // mistyped character and clearing the form would make the retry a re-entry.
        recoverMode = false;
        codeInput = "";
        newPassword = "";
      } catch (e) {
        deps.reportError((e as Error).message);
      } finally {
        deps.setUnlocking(false);
      }
    },

    async revokeOrgKey() {
      deps.reportAccountError(null);
      await inAccount(async () => {
        const r = await revokeRecoveryEnvelope();
        orgHeld = false;
        orgRevokedAt = r.revokedAt;
        revokeConfirm = false;
      });
    },

    closeAccountBlocks() {
      regeneratedCode = null;
      revokeConfirm = false;
    },

    applyPrincipals(p) {
      orgHeld = p.envelopePrincipalIds.includes(p.orgAccountId);
      orgRevokedAt = p.orgRecoveryRevokedAt;
    },

    reset() {
      issuedFor = null;
      issuedCode = null;
      issuedExpiresAt = null;
      issueError = null;
      regeneratedCode = null;
      recoverMode = false;
      codeInput = "";
      newPassword = "";
      revokeConfirm = false;
      nudgeDismissed = false;
    },
  };
}

import { describe, it, expect, vi, beforeEach } from "vitest";

// W76 — the first unit tests for the browser half of the recovery ladder.
//
// W73 built the ladder and W75 fixed its server-side attempt cap, so both ends of the wire are
// covered — the endpoints by function tests, the happy path by an e2e that types a code and lands on
// the dashboard. What neither can ask is what the SCREEN is holding: which rung the request went out
// on, what is still in memory after the dialog closes, and what a failed attempt left behind. Those
// are the assertions below, and each one is written so that it fails if the property is removed.

const auth = vi.hoisted(() => ({
  issueRecoveryCode: vi.fn(),
  recoverAccount: vi.fn(),
  redeemRecoveryCode: vi.fn(),
  regenerateRecoveryCode: vi.fn(),
  revokeRecoveryEnvelope: vi.fn(),
}));
// detectRecoveryKind is left real (not in `auth`): the controller's `kind` getter depends on its
// actual shape-detection logic, which is exactly what the tests below assert on.
vi.mock("@tinytars/vault/auth-recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tinytars/vault/auth-recovery")>()),
  ...auth,
}));

import { createRecoveryController, type RecoveryControllerDeps } from "@tinytars/frame/recovery-controller.svelte";
import { createVaultSession } from "@tinytars/frame/vault-session.svelte";

const PROVIDER_KEY = { id: "provider" } as unknown as CryptoKey;
const ACCOUNT_KEY = { id: "account", extractable: true } as unknown as CryptoKey;

const PATIENT = {
  ownerAccountId: "acct-liz",
  displayName: "Liz",
  envelope: { wrappedDEK: "wrapped", ephemeralPublicKeyJwk: { kid: "eph" } as JsonWebKey },
};

/** Everything App owns, recorded rather than performed, so a handler's effects are inspectable. */
function harness(over: Partial<RecoveryControllerDeps> = {}) {
  const session = createVaultSession();
  const host = {
    email: "liz@example.com",
    accountBusy: false,
    accountError: null as string | null,
    unlocking: false,
    error: null as string | null,
    entered: [] as unknown[],
    refreshed: 0,
    extractable: ACCOUNT_KEY as CryptoKey | null,
  };
  const deps: RecoveryControllerDeps = {
    session,
    getEmail: () => host.email,
    ensureExtractableKey: () => host.extractable,
    refreshAccount: async () => {
      host.refreshed++;
    },
    setAccountBusy: (b) => (host.accountBusy = b),
    reportAccountError: (m) => (host.accountError = m),
    setUnlocking: (b) => (host.unlocking = b),
    reportError: (m) => (host.error = m),
    enterRecovered: async (r) => {
      host.entered.push(r);
    },
    ...over,
  };
  return { session, host, recovery: createRecoveryController<typeof PATIENT>(deps) };
}

const SESSION = { vaultId: "v1", r2Key: "r2", privateKey: ACCOUNT_KEY, dek: null, rotationPending: false };

beforeEach(() => {
  vi.clearAllMocks();
  auth.recoverAccount.mockResolvedValue(SESSION);
  auth.redeemRecoveryCode.mockResolvedValue(SESSION);
  auth.issueRecoveryCode.mockResolvedValue({ code: "AAAA-BBBB", expiresAt: "2026-09-01T00:00:00Z" });
  auth.regenerateRecoveryCode.mockResolvedValue("NEW-CODE");
  auth.revokeRecoveryEnvelope.mockResolvedValue({ status: "ok", revokedAt: "2026-08-26T10:00:00Z" });
});

// W80 — self-service codes are always 20 raw characters; provider-issued grant codes are
// always 12 (displayed grouped). Fixtures below match those shapes so `recovery.kind`, now
// read off `codeInput` by `detectRecoveryKind`, routes the way a real code would.
const SELF_CODE = "AAAABBBBCCCCDDDDEEEE"; // 20 chars
const GRANT_CODE = "AAAA-BBBB-CCCC"; // 12 chars once the display grouping is stripped

describe("which rung of the ladder the code goes to", () => {
  // The two rungs are one form with one submit button, and what distinguishes them is the shape of
  // what was typed or pasted — there is no separate flag to set. Sending a patient's own recovery
  // code to the provider-grant endpoint (or the reverse) can't happen: the two lengths never collide.
  it("sends a self-held code to recoverAccount and never to the grant endpoint", async () => {
    const { recovery } = harness();
    recovery.codeInput = SELF_CODE;
    recovery.newPassword = "hunter2";
    await recovery.recover();
    expect(auth.recoverAccount).toHaveBeenCalledWith("liz@example.com", SELF_CODE, "hunter2");
    expect(auth.redeemRecoveryCode).not.toHaveBeenCalled();
  });

  it("sends a provider-issued code to redeemRecoveryCode and never to the self endpoint", async () => {
    const { recovery } = harness();
    recovery.codeInput = GRANT_CODE;
    recovery.newPassword = "hunter2";
    await recovery.recover();
    expect(auth.redeemRecoveryCode).toHaveBeenCalledWith("liz@example.com", GRANT_CODE, "hunter2");
    expect(auth.recoverAccount).not.toHaveBeenCalled();
  });

  it("re-routes mid-edit as the pasted text grows past the grant length", () => {
    const { recovery } = harness();
    recovery.codeInput = GRANT_CODE.replace(/-/g, ""); // the 12-char prefix of a paste in progress
    expect(recovery.kind).toBe("grant");
    recovery.codeInput = SELF_CODE; // the full 20-char code, once the paste finishes
    expect(recovery.kind).toBe("code");
  });

  it("trims the typed code, so a trailing space from a paste is not a wrong code", async () => {
    const { recovery } = harness();
    recovery.codeInput = `  ${SELF_CODE} \n`;
    await recovery.recover();
    expect(auth.recoverAccount).toHaveBeenCalledWith("liz@example.com", SELF_CODE, "");
  });

  it("does not call out at all without an email or with a blank code", async () => {
    const a = harness({ getEmail: () => "" });
    a.recovery.codeInput = SELF_CODE;
    await a.recovery.recover();

    const b = harness();
    b.recovery.codeInput = "   ";
    await b.recovery.recover();

    expect(auth.recoverAccount).not.toHaveBeenCalled();
    // Not merely "no request": the button must not appear to be working either.
    expect(a.host.unlocking).toBe(false);
    expect(b.host.unlocking).toBe(false);
  });
});

describe("what a recovery attempt leaves behind", () => {
  it("keeps the typed code and its rung when the attempt fails", async () => {
    // The usual failure here is one mistyped character. Clearing the field would turn a correction
    // into a re-entry of a 20-character code the person is reading off paper or hearing on a call.
    const typo = "AAAA-BBBB-CCDX"; // 12 chars once stripped — still reads as a grant code, just wrong
    auth.recoverAccount.mockRejectedValue(new Error("that code is not valid"));
    auth.redeemRecoveryCode.mockRejectedValue(new Error("that code is not valid"));
    const { host, recovery } = harness();
    recovery.recoverMode = true;
    recovery.codeInput = typo;
    recovery.newPassword = "hunter2";
    await recovery.recover();

    expect(host.error).toBe("that code is not valid");
    expect(recovery.codeInput).toBe(typo);
    expect(recovery.newPassword).toBe("hunter2");
    expect(recovery.kind).toBe("grant");
    expect(recovery.recoverMode).toBe(true);
    expect(host.entered).toEqual([]);
    expect(host.unlocking).toBe(false);
  });

  it("clears both secrets once the session is entered, which also resets the rung", async () => {
    const { host, recovery } = harness();
    recovery.recoverMode = true;
    recovery.codeInput = GRANT_CODE;
    recovery.newPassword = "hunter2";
    await recovery.recover();

    expect(host.entered).toEqual([SESSION]);
    expect(recovery.codeInput).toBe("");
    expect(recovery.newPassword).toBe("");
    expect(recovery.kind).toBe("code");
    expect(recovery.recoverMode).toBe(false);
  });

  it("does not clear the form when entering the session is what failed", async () => {
    // enterRecovered is App's: the code was accepted and the account is recovered, so re-submitting
    // the same code would now fail as spent. Leaving the field filled is what makes that visible.
    const { host, recovery } = harness({
      enterRecovered: async () => {
        throw new Error("could not open the vault");
      },
    });
    recovery.codeInput = SELF_CODE;
    await recovery.recover();
    expect(host.error).toBe("could not open the vault");
    expect(recovery.codeInput).toBe(SELF_CODE);
  });
});

describe("the one-time code a provider reads to a patient", () => {
  it("needs a provider key — no key, no dialog", async () => {
    const { recovery } = harness();
    await recovery.issueForPatient(PATIENT);
    expect(auth.issueRecoveryCode).not.toHaveBeenCalled();
    expect(recovery.issuedFor).toBeNull();
  });

  it("re-wraps this patient's own envelope with the provider's key", async () => {
    const { session, recovery } = harness();
    session.setProviderKey(PROVIDER_KEY);
    await recovery.issueForPatient(PATIENT);
    expect(auth.issueRecoveryCode).toHaveBeenCalledWith("acct-liz", PATIENT.envelope, PROVIDER_KEY);
    expect(recovery.issuedCode).toBe("AAAA-BBBB");
    expect(recovery.issuedExpiresAt).toBe("2026-09-01T00:00:00Z");
    expect(recovery.issuing).toBe(false);
  });

  it("never shows the previous patient's code while the next one is loading", async () => {
    // The dialog opens on the row that was clicked. If the code from the last row survived into it,
    // a clinician would read a live code for the wrong patient out loud.
    const { session, recovery } = harness();
    session.setProviderKey(PROVIDER_KEY);
    await recovery.issueForPatient(PATIENT);

    const other = { ...PATIENT, ownerAccountId: "acct-pablo", displayName: "Pablo" };
    let release: (v: { code: string; expiresAt: string }) => void = () => {};
    auth.issueRecoveryCode.mockReturnValue(new Promise((r) => (release = r)));
    const pending = recovery.issueForPatient(other);

    expect(recovery.issuedFor?.ownerAccountId).toBe("acct-pablo");
    expect(recovery.issuedCode).toBeNull();
    expect(recovery.issuing).toBe(true);

    release({ code: "CCCC-DDDD", expiresAt: "2026-09-02T00:00:00Z" });
    await pending;
    expect(recovery.issuedCode).toBe("CCCC-DDDD");
  });

  it("reports a failure in the dialog and stops the spinner", async () => {
    auth.issueRecoveryCode.mockRejectedValue(new Error("that patient revoked your access"));
    const { session, recovery } = harness();
    session.setProviderKey(PROVIDER_KEY);
    await recovery.issueForPatient(PATIENT);
    expect(recovery.issueError).toBe("that patient revoked your access");
    expect(recovery.issuedCode).toBeNull();
    expect(recovery.issuing).toBe(false);
  });

  it("drops the code from memory when the dialog closes", async () => {
    const { session, recovery } = harness();
    session.setProviderKey(PROVIDER_KEY);
    await recovery.issueForPatient(PATIENT);
    recovery.closeIssueDialog();
    expect(recovery.issuedFor).toBeNull();
    expect(recovery.issuedCode).toBeNull();
    expect(recovery.issuedExpiresAt).toBeNull();
    expect(recovery.issueError).toBeNull();
  });
});

describe("minting a replacement code for one's own account", () => {
  it("shows the new code and re-reads the method list", async () => {
    const { host, recovery } = harness();
    await recovery.regenerate();
    expect(auth.regenerateRecoveryCode).toHaveBeenCalledWith(ACCOUNT_KEY);
    expect(recovery.regeneratedCode).toBe("NEW-CODE");
    expect(host.refreshed).toBe(1);
    expect(host.accountBusy).toBe(false);
  });

  it("stops before minting when the session key is not extractable", async () => {
    // ensureExtractableKey has already posted the "sign out and sign in again" message; minting
    // anyway would wrap a key that cannot be unwrapped, producing a code that opens nothing.
    const { host, recovery } = harness();
    host.extractable = null;
    await recovery.regenerate();
    expect(auth.regenerateRecoveryCode).not.toHaveBeenCalled();
    expect(recovery.regeneratedCode).toBeNull();
    expect(host.accountBusy).toBe(false);
  });

  it("reports a mint failure without presenting a code", async () => {
    auth.regenerateRecoveryCode.mockRejectedValue(new Error("recovery is unavailable right now"));
    const { host, recovery } = harness();
    await recovery.regenerate();
    expect(host.accountError).toBe("recovery is unavailable right now");
    expect(recovery.regeneratedCode).toBeNull();
    expect(host.refreshed).toBe(0);
    expect(host.accountBusy).toBe(false);
  });
});

describe("the org recovery key", () => {
  it("is held when the org account holds an envelope, not merely when nothing was revoked", () => {
    const { recovery } = harness();
    recovery.applyPrincipals({
      envelopePrincipalIds: ["acct-self", "acct-org"],
      orgAccountId: "acct-org",
      orgRecoveryRevokedAt: null,
    });
    expect(recovery.orgHeld).toBe(true);

    recovery.applyPrincipals({
      envelopePrincipalIds: ["acct-self"],
      orgAccountId: "acct-org",
      orgRecoveryRevokedAt: "2026-08-01T00:00:00Z",
    });
    expect(recovery.orgHeld).toBe(false);
    expect(recovery.orgRevokedAt).toBe("2026-08-01T00:00:00Z");
  });

  it("takes the revocation timestamp from the server, not the clock", async () => {
    const { recovery } = harness();
    recovery.applyPrincipals({ envelopePrincipalIds: ["acct-org"], orgAccountId: "acct-org", orgRecoveryRevokedAt: null });
    recovery.revokeConfirm = true;
    await recovery.revokeOrgKey();
    expect(recovery.orgHeld).toBe(false);
    expect(recovery.orgRevokedAt).toBe("2026-08-26T10:00:00Z");
    expect(recovery.revokeConfirm).toBe(false);
  });

  it("still reads as held when the revoke failed", async () => {
    // This is the irreversible one: telling a patient their org recovery key is gone when the server
    // still holds it is the same lie in the safer direction, and they would stop treating the
    // password as the only key. The confirm stays armed so the retry is one click.
    auth.revokeRecoveryEnvelope.mockRejectedValue(new Error("network"));
    const { host, recovery } = harness();
    recovery.applyPrincipals({ envelopePrincipalIds: ["acct-org"], orgAccountId: "acct-org", orgRecoveryRevokedAt: null });
    recovery.revokeConfirm = true;
    await recovery.revokeOrgKey();
    expect(host.accountError).toBe("network");
    expect(recovery.orgHeld).toBe(true);
    expect(recovery.orgRevokedAt).toBeNull();
    expect(recovery.revokeConfirm).toBe(true);
    expect(host.accountBusy).toBe(false);
  });
});

describe("closing versus signing out", () => {
  it("closing the Account modal drops the shown code but leaves the lock screen alone", async () => {
    const { recovery } = harness();
    await recovery.regenerate();
    recovery.revokeConfirm = true;
    recovery.codeInput = "half-typed";
    recovery.recoverMode = true;

    recovery.closeAccountBlocks();
    expect(recovery.regeneratedCode).toBeNull();
    expect(recovery.revokeConfirm).toBe(false);
    expect(recovery.codeInput).toBe("half-typed");
    expect(recovery.recoverMode).toBe(true);
  });

  it("signing out clears every code, typed or shown", async () => {
    const { session, recovery } = harness();
    session.setProviderKey(PROVIDER_KEY);
    await recovery.issueForPatient(PATIENT);
    await recovery.regenerate();
    recovery.codeInput = "half-typed";
    recovery.newPassword = "hunter2";
    recovery.recoverMode = true;
    recovery.nudgeDismissed = true;

    recovery.reset();
    expect(recovery.issuedFor).toBeNull();
    expect(recovery.issuedCode).toBeNull();
    expect(recovery.regeneratedCode).toBeNull();
    expect(recovery.codeInput).toBe("");
    expect(recovery.newPassword).toBe("");
    expect(recovery.kind).toBe("code");
    expect(recovery.recoverMode).toBe(false);
    expect(recovery.nudgeDismissed).toBe(false);
  });
});

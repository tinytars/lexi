import { describe, it, expect, vi, beforeEach } from "vitest";

// W76 — the first unit tests for the support console's browser half.
//
// The wire is well covered: support-access-function.test.ts and support-provider-roster-function.test.ts
// assert what the endpoints allow, and W75's auth-client-support.test.ts asserts what the client sends.
// None of them can ask what the SCREEN is holding — whether a drilled-into roster still shows a button
// that was just pressed, whether the previous agent's roster is still on it after a sign-out, or whether
// a drill-in is even attempted without the key that would make it readable. Those are the assertions
// below, each written so it fails if the property is removed.

const auth = vi.hoisted(() => ({
  listSupportOwners: vi.fn(),
  listSupportProviders: vi.fn(),
  listSupportRequests: vi.fn(),
  requestSupportAccess: vi.fn(),
  cancelSupportRequest: vi.fn(),
  getProviderRoster: vi.fn(),
  enterSupportOwner: vi.fn(),
}));
vi.mock("@tinytars/vault/auth-support", () => auth);

import { createSupportAccess, type SupportAccessDeps, type SupportEntry } from "@tinytars/frame/support-access.svelte";
import type { VaultEntry } from "@tinytars/frame/vault-session.svelte";
import { createVaultSession } from "@tinytars/frame/vault-session.svelte";

const PROVIDER_KEY = { id: "support-agent" } as unknown as CryptoKey;

const PATIENT = { ownerAccountId: "acct-liz", displayName: "Liz", email: "liz@example.com", expiresAt: null };
const PROVIDER = { providerAccountId: "acct-dr", displayName: "Dr. Reyes", email: "dr@example.com" };
const REQUEST = { linkId: "link-1", email: "liz@example.com", status: "invited" };
const ENTRY: SupportEntry = {
  ownerAccountId: "acct-liz",
  displayName: "Liz",
  email: "liz@example.com",
  vaultId: "vault-liz",
  r2Key: "vaults/vault-liz.enc",
  envelope: { wrappedDEK: "wrapped", ephemeralPublicKeyJwk: { kid: "eph" } as JsonWebKey },
};

/** Everything App owns, recorded rather than performed. */
function harness(over: Partial<SupportAccessDeps> = {}) {
  const session = createVaultSession();
  session.setProviderKey(PROVIDER_KEY);
  const host = {
    error: null as string | null,
    opened: [] as { entry: VaultEntry; key: CryptoKey }[],
  };
  const deps: SupportAccessDeps = {
    session,
    reportError: (m) => (host.error = m),
    openPatientVault: async (entry, key) => {
      host.opened.push({ entry, key });
    },
    ...over,
  };
  return { support: createSupportAccess(deps), host, session };
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.listSupportOwners.mockResolvedValue([PATIENT]);
  auth.listSupportProviders.mockResolvedValue([PROVIDER]);
  auth.listSupportRequests.mockResolvedValue([REQUEST]);
  auth.getProviderRoster.mockResolvedValue([{ ownerAccountId: "acct-liz", displayName: "Liz", openable: false, pending: false }]);
  auth.requestSupportAccess.mockResolvedValue(undefined);
  auth.cancelSupportRequest.mockResolvedValue(undefined);
  auth.enterSupportOwner.mockResolvedValue(ENTRY);
});

describe("entering the support console", () => {
  it("loads all three lists, not just the one the screen opens on", async () => {
    const { support } = harness();
    await support.beginSession();
    expect(support.isSupportSession).toBe(true);
    expect(support.patients).toEqual([PATIENT]);
    expect(support.providers).toEqual([PROVIDER]);
    expect(support.requests).toEqual([REQUEST]);
  });

  it("stays in the console when a list fails, showing the error rather than a blank shell", async () => {
    auth.listSupportProviders.mockRejectedValue(new Error("providers unavailable"));
    const { support, host } = harness();
    await support.beginSession();
    expect(support.isSupportSession).toBe(true);
    expect(host.error).toBe("providers unavailable");
    // The failure is confined to its own list: the ones that answered are still here.
    expect(support.patients).toEqual([PATIENT]);
    expect(support.requests).toEqual([REQUEST]);
  });
});

describe("asking a patient for access", () => {
  it("refuses to send an empty or whitespace-only email", async () => {
    const { support } = harness();
    support.requestEmail = "   ";
    await support.requestAccess();
    expect(auth.requestSupportAccess).not.toHaveBeenCalled();
  });

  it("sends the trimmed address and clears the field so the ask is not repeatable by accident", async () => {
    const { support } = harness();
    support.requestEmail = "  liz@example.com  ";
    await support.requestAccess();
    expect(auth.requestSupportAccess).toHaveBeenCalledWith("liz@example.com");
    expect(support.requestEmail).toBe("");
  });

  it("keeps the typed address when the ask fails, so the retry is not a re-entry", async () => {
    auth.requestSupportAccess.mockRejectedValue(new Error("already invited"));
    const { support, host } = harness();
    support.requestEmail = "liz@example.com";
    await support.requestAccess();
    expect(host.error).toBe("already invited");
    expect(support.requestEmail).toBe("liz@example.com");
  });

  it("re-reads the drilled-into roster, so the row stops offering the button just pressed", async () => {
    const { support } = harness();
    await support.openProvider(PROVIDER as never);
    expect(support.providerView?.roster[0].pending).toBe(false);
    auth.getProviderRoster.mockResolvedValue([{ ownerAccountId: "acct-liz", displayName: "Liz", openable: false, pending: true }]);
    support.requestEmail = "liz@example.com";
    await support.requestAccess();
    expect(support.providerView?.roster[0].pending).toBe(true);
  });

  it("does not fetch a roster when none is drilled into", async () => {
    const { support } = harness();
    support.requestEmail = "liz@example.com";
    await support.requestAccess();
    expect(auth.getProviderRoster).not.toHaveBeenCalled();
  });
});

describe("cancelling a pending request", () => {
  it("reloads the pending list and the open roster together", async () => {
    const { support } = harness();
    await support.openProvider(PROVIDER as never);
    auth.listSupportRequests.mockResolvedValue([]);
    auth.getProviderRoster.mockResolvedValue([{ ownerAccountId: "acct-liz", displayName: "Liz", openable: false, pending: false }]);
    await support.cancelRequest("link-1");
    expect(auth.cancelSupportRequest).toHaveBeenCalledWith("link-1");
    expect(support.requests).toEqual([]);
    expect(auth.getProviderRoster).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed cancellation instead of pretending the request is gone", async () => {
    auth.cancelSupportRequest.mockRejectedValue(new Error("link not found"));
    const { support, host } = harness();
    await support.cancelRequest("link-1");
    expect(host.error).toBe("link not found");
    expect(auth.listSupportRequests).not.toHaveBeenCalled();
  });
});

describe("drilling into a clinician's roster", () => {
  it("opens onto that clinician's patients and closes back to the top level", async () => {
    const { support } = harness();
    await support.openProvider(PROVIDER as never);
    expect(auth.getProviderRoster).toHaveBeenCalledWith("acct-dr");
    expect(support.providerView?.providerAccountId).toBe("acct-dr");
    support.closeProvider();
    expect(support.providerView).toBeNull();
  });

  it("leaves the console at the top level when the roster cannot be read", async () => {
    auth.getProviderRoster.mockRejectedValue(new Error("not your provider"));
    const { support, host } = harness();
    await support.openProvider(PROVIDER as never);
    expect(support.providerView).toBeNull();
    expect(host.error).toBe("not your provider");
  });
});

describe("the audited drill-in", () => {
  it("hands App the envelope and the very key that was checked here", async () => {
    const { support, host } = harness();
    await support.enterPatient("acct-liz");
    expect(auth.enterSupportOwner).toHaveBeenCalledWith("acct-liz");
    expect(host.opened).toEqual([{ entry: ENTRY, key: PROVIDER_KEY }]);
  });

  it("does not call the audited endpoint at all without a key to unwrap with", async () => {
    const { support, session, host } = harness();
    session.setProviderKey(null);
    await support.enterPatient("acct-liz");
    // The audit log is the record of who looked at a patient. An access that cannot possibly be read
    // must not be written into it.
    expect(auth.enterSupportOwner).not.toHaveBeenCalled();
    expect(host.opened).toEqual([]);
  });

  it("reports a denied drill-in rather than leaving the click looking unregistered", async () => {
    auth.enterSupportOwner.mockRejectedValue(new Error("access expired"));
    const { support, host } = harness();
    await support.enterPatient("acct-liz");
    expect(host.error).toBe("access expired");
    expect(host.opened).toEqual([]);
  });
});

describe("signing out of the console", () => {
  it("clears the drilled-into roster, not only the three lists that reload themselves", async () => {
    const { support } = harness();
    await support.beginSession();
    await support.openProvider(PROVIDER as never);
    support.requestEmail = "liz@example.com";

    support.reset();

    // The roster is the one nothing reloads on the next sign-in: leaving it set opened the next
    // support agent onto the previous agent's clinician.
    expect(support.providerView).toBeNull();
    expect(support.isSupportSession).toBe(false);
    expect(support.patients).toEqual([]);
    expect(support.providers).toEqual([]);
    expect(support.requests).toEqual([]);
    expect(support.requestEmail).toBe("");
  });
});

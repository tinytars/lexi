import { describe, it, expect, vi, beforeEach } from "vitest";

// W76 — the first unit tests for how a session starts and whose record it is on.
//
// Playwright drives this cluster constantly and can assert none of it: a resume decision happens
// before any pixel exists, and the property that matters on a shared machine — a stored account key
// whose session has expired is DROPPED rather than kept — is invisible from the screen either way,
// because both outcomes look like a lock screen. Same for the drill-in: switching patients must not
// leave the previous patient's data key reachable, and a DEK in memory renders nothing.

import { createRosterSession, RESUME_MARKER, type RosterSessionDeps, type RosterPatient } from "@tinytars/frame/roster-session.svelte";
import { createVaultSession, type VaultEntry } from "@tinytars/frame/vault-session.svelte";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { bytesToB64 } from "@tinytars/vault/base64";

const auth = {
  resumeSession: vi.fn(),
  bootstrapGoogleSession: vi.fn(),
  getMyAccount: vi.fn(),
  revokeProvider: vi.fn(),
};
const keyStore = {
  getAccountKey: vi.fn(),
  putAccountKey: vi.fn(),
  clearAccountKey: vi.fn(),
};
const fakeFetch = vi.fn();

const OWNER_KEY = { id: "owner" } as unknown as CryptoKey;
const PROVIDER_KEY = { id: "provider" } as unknown as CryptoKey;
const DEK = { id: "dek" } as unknown as CryptoKey;

const PATIENT: RosterPatient = {
  linkId: "link-1",
  vaultId: "vault-blair",
  ownerAccountId: "acct-blair",
  displayName: "Blair",
  email: "blair@example.com",
  r2Key: "vaults/vault-blair.enc",
  envelope: { wrappedDEK: "wrapped", ephemeralPublicKeyJwk: { kid: "eph" } as JsonWebKey },
};

const rawKey = async (k: CryptoKey) => new Uint8Array(await crypto.subtle.exportKey("raw", k));

/** A localStorage that is real enough to hold the resume marker, since the marker IS the test. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    has: (k: string) => map.has(k),
  };
}

function harness(over: Partial<RosterSessionDeps> = {}) {
  const session = createVaultSession();
  const host = {
    error: null as string | null,
    cleared: 0,
    ownVaults: [] as { r2Key: string; dek: CryptoKey }[],
    afterOwner: [] as boolean[],
    support: 0,
    clinician: 0,
    opened: [] as { entry: VaultEntry; key: CryptoKey }[],
    closedVault: 0,
    confirm: true,
  };
  const deps: RosterSessionDeps = {
    session,
    reportError: (m) => (host.error = m),
    clearLoginForm: () => void host.cleared++,
    openOwnVault: async (r2Key, dek) => {
      host.ownVaults.push({ r2Key, dek });
      session.open("vault-own", dek);
    },
    afterOwnerEnter: async (rotationPending) => void host.afterOwner.push(rotationPending),
    beginSupportSession: async () => void host.support++,
    beginClinicianSession: async () => void host.clinician++,
    openPatientVault: async (entry, key) => {
      host.opened.push({ entry, key });
      session.open(entry.r2Key, DEK);
    },
    closeVault: () => void host.closedVault++,
    confirmRemoval: () => host.confirm,
    api: { ...auth, ...keyStore, fetch: fakeFetch },
    ...over,
  };
  return { roster: createRosterSession(deps), host, session };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", fakeStorage());
  fakeFetch.mockImplementation(async () => new Response(JSON.stringify({ patients: [PATIENT] }), { status: 200 }));
  auth.getMyAccount.mockResolvedValue({ id: "acct-dr", providerKind: "clinician" });
});

describe("enterAccount routing", () => {
  it("takes the owner path when a vault, key and DEK are all present", async () => {
    const { roster, host, session } = harness();
    await roster.enterAccount({ vaultId: "v", r2Key: "vaults/v.enc", privateKey: OWNER_KEY, dek: DEK, rotationPending: true });
    expect(roster.isProvider).toBe(false);
    expect(session.ownerKey).toBe(OWNER_KEY);
    expect(session.providerKey).toBeNull();
    expect(host.ownVaults).toEqual([{ r2Key: "vaults/v.enc", dek: DEK }]);
    expect(host.afterOwner).toEqual([true]);
    expect(auth.getMyAccount).not.toHaveBeenCalled();
  });

  it("takes the provider path when there is no vault of one's own", async () => {
    const { roster, session, host } = harness();
    await roster.enterAccount({ vaultId: null, r2Key: null, privateKey: PROVIDER_KEY, dek: null });
    expect(roster.isProvider).toBe(true);
    expect(session.providerKey).toBe(PROVIDER_KEY);
    expect(session.ownerKey).toBeNull();
    expect(host.clinician).toBe(1);
    expect(roster.patients).toEqual([PATIENT]);
  });

  it("gives a support account the console and never loads a clinician roster", async () => {
    auth.getMyAccount.mockResolvedValue({ id: "acct-s", providerKind: "support" });
    const { roster, host } = harness();
    await roster.enterAccount({ vaultId: null, r2Key: null, privateKey: PROVIDER_KEY, dek: null });
    expect(host.support).toBe(1);
    expect(host.clinician).toBe(0);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("clears the login form on every path", async () => {
    const { roster, host } = harness();
    await roster.enterAccount({ vaultId: null, r2Key: null, privateKey: PROVIDER_KEY, dek: null });
    expect(host.cleared).toBe(1);
  });
});

describe("cold-load resume", () => {
  it("does not probe at all without a marker", async () => {
    const { roster } = harness();
    await roster.bootResume();
    expect(keyStore.getAccountKey).not.toHaveBeenCalled();
    expect(auth.bootstrapGoogleSession).not.toHaveBeenCalled();
    expect(roster.resuming).toBe(false);
  });

  it("is not resuming before it is asked to, and raises the flag before it yields", async () => {
    localStorage.setItem(RESUME_MARKER, "key");
    keyStore.getAccountKey.mockResolvedValue(OWNER_KEY);
    auth.resumeSession.mockResolvedValue(null);
    const { roster } = harness();
    // A first-time visitor must get the sign-in form, not "Restoring your session…".
    expect(roster.resuming).toBe(false);
    // Synchronously — not one microtask later. A host that has to hold the flag up during the gap
    // ends up owning a second copy of it, and W76 shipped exactly that: a copy nothing lowered, which
    // left every reloaded page on the restore screen forever.
    const done = roster.bootResume();
    expect(roster.resuming).toBe(true);
    await done;
    expect(roster.resuming).toBe(false);
  });

  it("resumes from the stored key, unwrapping the owner envelope", async () => {
    const owner = await generateAccountKeypair();
    const dek = await generateDEK();
    const envelope = await wrapDEKForPublicKey(dek, owner.publicKeyJwk);
    localStorage.setItem(RESUME_MARKER, "key");
    keyStore.getAccountKey.mockResolvedValue(owner.privateKey);
    auth.resumeSession.mockResolvedValue({
      vaultId: "v",
      r2Key: "vaults/v.enc",
      ownerEnvelope: { wrappedDEK: bytesToB64(envelope.wrappedDEK), ephemeralPublicKeyJwk: envelope.ephemeralPublicKeyJwk },
      rotationPending: false,
    });
    const { roster, host, session } = harness();
    await roster.bootResume();
    expect(host.ownVaults.map((v) => v.r2Key)).toEqual(["vaults/v.enc"]);
    expect(await rawKey(host.ownVaults[0].dek)).toEqual(await rawKey(dek));
    expect(session.ownerKey).toBe(owner.privateKey);
    expect(localStorage.getItem(RESUME_MARKER)).toBe("key");
  });

  it("DROPS a stored key whose session has expired, rather than keeping it", async () => {
    localStorage.setItem(RESUME_MARKER, "key");
    keyStore.getAccountKey.mockResolvedValue(OWNER_KEY);
    auth.resumeSession.mockResolvedValue(null);
    const { roster, host, session } = harness();
    await roster.bootResume();
    expect(keyStore.clearAccountKey).toHaveBeenCalledTimes(1);
    expect(session.ownerKey).toBeNull();
    expect(host.ownVaults).toEqual([]);
    expect(localStorage.getItem(RESUME_MARKER)).toBeNull();
  });

  it("resumes a Google session, which holds no client key", async () => {
    localStorage.setItem(RESUME_MARKER, "google");
    auth.bootstrapGoogleSession.mockResolvedValue({ vaultId: "v", r2Key: "vaults/v.enc", privateKey: OWNER_KEY, dek: DEK });
    const { roster, host } = harness();
    await roster.bootResume();
    expect(keyStore.getAccountKey).not.toHaveBeenCalled();
    expect(host.ownVaults).toHaveLength(1);
  });

  it("clears the marker when the probe it names fails, so the next load goes straight to the lock screen", async () => {
    localStorage.setItem(RESUME_MARKER, "google");
    auth.bootstrapGoogleSession.mockRejectedValue(new Error("401"));
    const { roster } = harness();
    await roster.bootResume();
    expect(localStorage.getItem(RESUME_MARKER)).toBeNull();
    expect(roster.resuming).toBe(false);
  });

  it("stops resuming even when the probe throws outright", async () => {
    localStorage.setItem(RESUME_MARKER, "key");
    keyStore.getAccountKey.mockResolvedValue(OWNER_KEY);
    auth.resumeSession.mockRejectedValue(new Error("network"));
    const { roster } = harness();
    await roster.bootResume();
    expect(roster.resuming).toBe(false);
    expect(localStorage.getItem(RESUME_MARKER)).toBeNull();
  });
});

describe("persistSessionKey", () => {
  it("writes the marker only after the key is actually stored", async () => {
    const order: string[] = [];
    keyStore.putAccountKey.mockImplementation(async () => void order.push("key"));
    const { roster } = harness();
    await roster.persistSessionKey(OWNER_KEY);
    order.push(localStorage.getItem(RESUME_MARKER) === "key" ? "marker" : "no-marker");
    expect(order).toEqual(["key", "marker"]);
  });

  it("advertises no resume when persistence is unavailable", async () => {
    keyStore.putAccountKey.mockRejectedValue(new Error("private browsing"));
    const { roster } = harness();
    await roster.persistSessionKey(OWNER_KEY);
    expect(localStorage.getItem(RESUME_MARKER)).toBeNull();
  });
});

describe("the roster", () => {
  it("leaves the previous roster standing when the refresh fails", async () => {
    const { roster } = harness();
    await roster.loadPatients();
    expect(roster.patients).toEqual([PATIENT]);
    fakeFetch.mockImplementation(async () => new Response("nope", { status: 500 }));
    await roster.loadPatients();
    expect(roster.patients).toEqual([PATIENT]);
  });

  it("does not revoke when the confirmation is declined", async () => {
    const { roster } = harness({ confirmRemoval: () => false });
    await roster.removeFromRoster(PATIENT);
    expect(auth.revokeProvider).not.toHaveBeenCalled();
  });

  it("revokes and reloads on confirmation", async () => {
    const { roster } = harness();
    await roster.removeFromRoster(PATIENT);
    expect(auth.revokeProvider).toHaveBeenCalledWith("link-1");
    expect(fakeFetch).toHaveBeenCalled();
  });

  it("reports a failed revocation instead of silently leaving the row", async () => {
    auth.revokeProvider.mockRejectedValue(new Error("still linked"));
    const { roster, host } = harness();
    await roster.removeFromRoster(PATIENT);
    expect(host.error).toBe("still linked");
  });
});

describe("label", () => {
  it("shows the email when the name is the untouched local-part", () => {
    const { roster } = harness();
    expect(roster.label({ ...PATIENT, displayName: "blair" })).toBe("blair@example.com");
  });

  it("shows the email for the Google placeholder and for no name at all", () => {
    const { roster } = harness();
    expect(roster.label({ ...PATIENT, displayName: "New member" })).toBe("blair@example.com");
    expect(roster.label({ ...PATIENT, displayName: "   " })).toBe("blair@example.com");
  });

  it("keeps a human-set name, including one that only differs by case", () => {
    const { roster } = harness();
    expect(roster.label({ ...PATIENT, displayName: "Blair" })).toBe("Blair");
    expect(roster.label({ ...PATIENT, displayName: "Blair Okonjo" })).toBe("Blair Okonjo");
  });

  it("falls back to the name when there is no email to show", () => {
    const { roster } = harness();
    expect(roster.label({ ...PATIENT, email: null, displayName: "Blair" })).toBe("Blair");
  });
});

describe("the drill-in", () => {
  it("does not attempt a drill-in without a provider key", async () => {
    const { roster, host } = harness();
    await roster.enterPatient(PATIENT);
    expect(host.opened).toEqual([]);
  });

  it("hands the host the entry and the key that was checked here", async () => {
    const { roster, host, session } = harness();
    session.setProviderKey(PROVIDER_KEY);
    await roster.enterPatient(PATIENT);
    expect(host.opened).toEqual([{ entry: PATIENT, key: PROVIDER_KEY }]);
  });

  it("reports a failed drill-in rather than half-entering", async () => {
    const { roster, host, session } = harness({
      openPatientVault: async () => {
        throw new Error("envelope rejected");
      },
    });
    session.setProviderKey(PROVIDER_KEY);
    await roster.enterPatient(PATIENT);
    expect(host.error).toBe("envelope rejected");
    expect(roster.enteredPatient).toBeNull();
  });

  it("leaves no DEK or decrypted record from the previous patient when switching", async () => {
    const { roster, host, session } = harness();
    await roster.enterAccount({ vaultId: null, r2Key: null, privateKey: PROVIDER_KEY, dek: null });
    await roster.enterPatient(PATIENT);
    roster.setEnteredPatient({ email: PATIENT.email, displayName: PATIENT.displayName });
    expect(session.dek).toBe(DEK);

    roster.backToRoster();
    expect(session.dek).toBeNull();
    expect(session.r2Id).toBeNull();
    expect(session.isOpen).toBe(false);
    expect(host.closedVault).toBe(1);
    expect(roster.enteredPatient).toBeNull();
    // The provider is still signed in — the key that opens the NEXT patient is the one thing kept.
    expect(session.providerKey).toBe(PROVIDER_KEY);
    expect(roster.isProvider).toBe(true);
    expect(roster.patients).toEqual([PATIENT]);
  });
});

describe("reset", () => {
  it("clears the roster, the role and who was entered", async () => {
    const { roster, session } = harness();
    await roster.enterAccount({ vaultId: null, r2Key: null, privateKey: PROVIDER_KEY, dek: null });
    roster.setEnteredPatient({ email: "blair@example.com", displayName: "Blair" });
    roster.reset();
    expect(roster.isProvider).toBe(false);
    expect(roster.patients).toEqual([]);
    expect(roster.enteredPatient).toBeNull();
    void session;
  });
});

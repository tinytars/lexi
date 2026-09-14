// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// W76 — the first unit tests for the panel that can lock a person out of their own health record.
//
// Adding and removing sign-in methods is the one cluster in App.svelte whose failure mode is not a
// wrong number on a screen: remove the last way in and the record is unreachable by anyone, forever.
// The server refuses that (functions/api/account/methods.ts:126) and is tested for it; the browser's
// half of the rule lived in a `disabled` attribute, which is an affordance rather than an invariant —
// nothing asserted it, and nothing would have noticed it going away. These do.

const auth = vi.hoisted(() => ({
  getMyAccount: vi.fn(),
  listMethods: vi.fn(),
  updateProfile: vi.fn(),
  addPasswordMethod: vi.fn(),
  addPasskeyMethod: vi.fn(),
  addGoogleMethod: vi.fn(),
  removeMethod: vi.fn(),
}));
vi.mock("@tinytars/vault/auth-client", () => ({
  getMyAccount: auth.getMyAccount,
  addPasskeyMethod: auth.addPasskeyMethod,
  addGoogleMethod: auth.addGoogleMethod,
}));
vi.mock("@tinytars/vault/auth-recovery", () => ({
  listMethods: auth.listMethods,
  updateProfile: auth.updateProfile,
  addPasswordMethod: auth.addPasswordMethod,
  removeMethod: auth.removeMethod,
}));

import { createAccountMethods, type AccountMethodsDeps } from "@tinytars/frame/account-methods.svelte";

const EXTRACTABLE = { extractable: true } as unknown as CryptoKey;
const RESUMED = { extractable: false } as unknown as CryptoKey;

const ACCOUNT = { id: "a1", email: "blair@example.com", emailConfirmed: true, displayName: "Blair", providerKind: null, unitSystem: "metric" as const };
const method = (m: string, isRecovery = false) => ({ method: m, createdAt: "2026-01-01", isRecovery });

function harness(over: Partial<AccountMethodsDeps> = {}) {
  const host = {
    key: EXTRACTABLE as CryptoKey | null,
    provider: false,
    unitSystem: "imperial",
    ownerBlocks: 0,
  };
  const deps: AccountMethodsDeps = {
    getPrivateKey: () => host.key,
    isProviderSession: () => host.provider,
    applyUnitSystem: (u) => (host.unitSystem = u),
    loadOwnerBlocks: async () => {
      host.ownerBlocks++;
    },
    ...over,
  };
  return { account: createAccountMethods(deps), host };
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.getMyAccount.mockResolvedValue(ACCOUNT);
  auth.listMethods.mockResolvedValue([method("password"), method("passkey"), method("recovery", true)]);
  auth.updateProfile.mockResolvedValue(undefined);
  auth.addPasswordMethod.mockResolvedValue(undefined);
  auth.addPasskeyMethod.mockResolvedValue(undefined);
  auth.addGoogleMethod.mockResolvedValue(undefined);
  auth.removeMethod.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
});

describe("never leaving the account with no way in", () => {
  it("refuses to remove the only sign-in method, and says why", async () => {
    auth.listMethods.mockResolvedValue([method("password"), method("recovery", true)]);
    const { account } = harness();
    await account.openPanel();

    expect(account.removeBlockedReason("password")).toBe("You can't remove your only sign-in method");
    await account.remove("password");

    expect(auth.removeMethod).not.toHaveBeenCalled();
    expect(account.error).toBe("You can't remove your only sign-in method");
  });

  it("does not count a recovery credential as a way in", async () => {
    // A recovery code is redeemed to get back to a password; it cannot sign anyone in on its own, so
    // an account holding one plus a single password still has exactly one way in.
    auth.listMethods.mockResolvedValue([method("password"), method("recovery", true), method("recovery")]);
    const { account } = harness();
    await account.openPanel();
    expect(account.loginMethods.map((m) => m.method)).toEqual(["password"]);
    expect(account.removeBlockedReason("password")).not.toBeNull();
  });

  it("allows the removal once a second way in exists", async () => {
    const { account } = harness();
    await account.openPanel();
    expect(account.removeBlockedReason("password")).toBeNull();
    await account.remove("password");
    expect(auth.removeMethod).toHaveBeenCalledWith("password");
  });

  it("says nothing about a method the account does not have", async () => {
    auth.listMethods.mockResolvedValue([method("password")]);
    const { account } = harness();
    await account.openPanel();
    expect(account.removeBlockedReason("google")).toBeNull();
  });
});

describe("the panel's view of the account is the server's", () => {
  it("re-reads methods after every mutation rather than editing the list locally", async () => {
    const { account } = harness();
    await account.openPanel();
    auth.listMethods.mockResolvedValue([method("passkey"), method("recovery", true)]);

    await account.remove("password");

    expect(account.loginMethods.map((m) => m.method)).toEqual(["passkey"]);
  });

  it("leaves the list untouched when the server refuses the removal", async () => {
    auth.removeMethod.mockRejectedValue(new Error("cannot remove your last login method"));
    const { account } = harness();
    await account.openPanel();

    await account.remove("password");

    expect(account.error).toBe("cannot remove your last login method");
    expect(account.loginMethods.map((m) => m.method)).toEqual(["password", "passkey"]);
  });

  it("clears busy whether the mutation succeeds or fails", async () => {
    auth.updateProfile.mockRejectedValue(new Error("email already in use"));
    const { account } = harness();
    await account.saveProfile();
    expect(account.busy).toBe(false);
    expect(account.error).toBe("email already in use");
  });

  it("carries the account's unit system out to the shell", async () => {
    const { account, host } = harness();
    await account.refresh();
    expect(host.unitSystem).toBe("metric");
  });

  it("falls back to imperial when the account carries no preference", async () => {
    auth.getMyAccount.mockResolvedValue({ ...ACCOUNT, unitSystem: null });
    const { account, host } = harness();
    host.unitSystem = "metric";
    await account.refresh();
    expect(host.unitSystem).toBe("imperial");
  });
});

describe("opening the panel", () => {
  it("seeds the profile fields from the server, not from whatever was typed last", async () => {
    const { account } = harness();
    account.editEmail = "typo@example.com";
    await account.openPanel();
    expect(account.editEmail).toBe("blair@example.com");
    expect(account.editDisplayName).toBe("Blair");
    expect(account.open).toBe(true);
  });

  it("loads the owner-only blocks for an owned vault", async () => {
    const { account, host } = harness();
    await account.openPanel();
    expect(host.ownerBlocks).toBe(1);
  });

  it("does not ask for vault principals in a provider session, which has no vault", async () => {
    const { account, host } = harness();
    host.provider = true;
    await account.openPanel();
    expect(host.ownerBlocks).toBe(0);
    expect(account.error).toBeNull();
  });

  it("opens with the error rather than staying shut when the account cannot be read", async () => {
    auth.getMyAccount.mockRejectedValue(new Error("session expired"));
    const { account } = harness();
    await account.openPanel();
    expect(account.open).toBe(true);
    expect(account.error).toBe("session expired");
  });
});

describe("a key that cannot be re-wrapped", () => {
  it("stops every add-method path after a plain-refresh resume, before any request goes out", async () => {
    const { account, host } = harness();
    host.key = RESUMED;

    account.newPassword = "hunter2hunter2";
    await account.addPassword();
    await account.addPasskey();
    account.connectGoogle();

    expect(auth.addPasswordMethod).not.toHaveBeenCalled();
    expect(auth.addPasskeyMethod).not.toHaveBeenCalled();
    expect(account.error).toBe("For your security, sign out and sign in again to add or change a login method.");
  });

  it("says nothing at all when there is no key — that is a signed-out screen, not a warning", async () => {
    const { account, host } = harness();
    host.key = null;
    await account.addPasskey();
    expect(account.error).toBeNull();
    expect(auth.addPasskeyMethod).not.toHaveBeenCalled();
  });
});

describe("adding a password", () => {
  it("sends nothing when the field is empty", async () => {
    const { account } = harness();
    await account.addPassword();
    expect(auth.addPasswordMethod).not.toHaveBeenCalled();
  });

  it("clears the field only once the server has taken it", async () => {
    const { account } = harness();
    account.newPassword = "hunter2hunter2";
    await account.addPassword();
    expect(auth.addPasswordMethod).toHaveBeenCalledWith(EXTRACTABLE, "hunter2hunter2");
    expect(account.newPassword).toBe("");
  });

  it("keeps a rejected password in the field so the retry is not a re-entry", async () => {
    auth.addPasswordMethod.mockRejectedValue(new Error("password too short"));
    const { account } = harness();
    account.newPassword = "short";
    await account.addPassword();
    expect(account.error).toBe("password too short");
    expect(account.newPassword).toBe("short");
  });
});

describe("connecting Google through the popup", () => {
  const linked = () => new MessageEvent("message", { data: { type: "hd-google-linked" }, origin: window.location.origin });

  // A listener that correctly outlives its test — the foreign-origin case leaves one registered, which
  // is the behaviour under test — would otherwise answer the NEXT test's dispatch too. jsdom's window
  // is shared across a file, so the listeners are retired here rather than left to cross-talk.
  const registered: EventListener[] = [];
  let addListener: typeof window.addEventListener;

  beforeEach(() => {
    vi.stubGlobal("open", vi.fn(() => ({}) as Window));
    addListener = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, h: EventListener, o?: unknown) => {
      if (type === "message") registered.push(h);
      addListener(type as keyof WindowEventMap, h, o as AddEventListenerOptions);
    }) as typeof window.addEventListener;
  });

  afterEach(() => {
    window.addEventListener = addListener;
    for (const h of registered) window.removeEventListener("message", h);
    registered.length = 0;
  });

  it("finishes the link only when the popup reports back", async () => {
    const { account } = harness();
    account.connectGoogle();
    expect(auth.addGoogleMethod).not.toHaveBeenCalled();

    window.dispatchEvent(linked());
    await vi.waitFor(() => expect(auth.addGoogleMethod).toHaveBeenCalledWith(EXTRACTABLE));
  });

  it("ignores a message from any other origin", async () => {
    const { account } = harness();
    account.connectGoogle();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "hd-google-linked" }, origin: "https://evil.example" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(auth.addGoogleMethod).not.toHaveBeenCalled();
  });

  it("stops listening once the link is done, so a replayed message cannot re-run it", async () => {
    const { account } = harness();
    account.connectGoogle();
    window.dispatchEvent(linked());
    await vi.waitFor(() => expect(auth.addGoogleMethod).toHaveBeenCalledTimes(1));
    window.dispatchEvent(linked());
    await new Promise((r) => setTimeout(r, 0));
    expect(auth.addGoogleMethod).toHaveBeenCalledTimes(1);
  });

  it("names the account that is already linked elsewhere instead of a generic failure", async () => {
    const { account } = harness();
    account.connectGoogle();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "hd-google-error", error: "linked_elsewhere" }, origin: window.location.origin }));
    await vi.waitFor(() => expect(account.error).toBe("That Google account is already linked to another account."));
    expect(auth.addGoogleMethod).not.toHaveBeenCalled();
  });

  it("tells the person to enable pop-ups rather than failing silently", () => {
    vi.stubGlobal("open", vi.fn(() => null));
    const { account } = harness();
    account.connectGoogle();
    expect(account.error).toBe("Enable pop-ups for this site to connect Google.");
  });
});

describe("signing out", () => {
  it("leaves nothing of the previous account behind", async () => {
    const { account } = harness();
    await account.openPanel();
    account.newPassword = "hunter2hunter2";

    account.reset();

    expect(account.open).toBe(false);
    expect(account.info).toBeNull();
    expect(account.methods).toEqual([]);
    expect(account.loginMethods).toEqual([]);
    expect(account.editEmail).toBe("");
    expect(account.editDisplayName).toBe("");
    expect(account.newPassword).toBe("");
    expect(account.error).toBeNull();
  });
});

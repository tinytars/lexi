// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// W76 — the first unit tests for the panel that can lock a person out of their own health record.
//
// Adding and removing sign-in methods is the one cluster in App.svelte whose failure mode is not a
// wrong number on a screen: remove the last way in and the record is unreachable by anyone, forever.
// The server refuses that (functions/api/account/methods.ts:126) and is tested for it; the browser's
// half of the rule lived in a `disabled` attribute, which is an affordance rather than an invariant —
// nothing asserted it, and nothing would have noticed it going away. These do.

import { createAccountMethods, passkeyFailureMessage, type AccountMethodsDeps } from "@tinytars/frame/account-methods.svelte";

const auth = {
  getMyAccount: vi.fn(),
  listMethods: vi.fn(),
  updateProfile: vi.fn(),
  addPasswordMethod: vi.fn(),
  addPasskeyMethod: vi.fn(),
  addGoogleMethod: vi.fn(),
  removeMethod: vi.fn(),
  fetch: vi.fn(),
};

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
    // The real value, not a stand-in: these messages are asserted verbatim below, and the point of
    // the dependency is that the package carries no product name while the app's messages do.
    productName: "LexiTar",
    getPrivateKey: () => host.key,
    isProviderSession: () => host.provider,
    applyUnitSystem: (u) => (host.unitSystem = u),
    loadOwnerBlocks: async () => {
      host.ownerBlocks++;
    },
    api: auth,
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
  auth.fetch.mockResolvedValue(new Response("{}"));
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
    expect(account.error).toBe("For your security, sign out of LexiTar and sign in again to add or change a login method.");
  });

  // This test asserted the opposite until 2026-10-17: that a missing key says NOTHING, on the
  // argument that no key means a signed-out screen and a warning would be noise. The argument is
  // sound and the behaviour it licensed is not. If the branch is truly unreachable the sentence
  // costs nothing; if it is reachable, silence is a button that does nothing and says nothing,
  // which is exactly the report that sent us looking. A click always gets an answer.
  it("says why when there is no key, rather than returning silently", async () => {
    const { account, host } = harness();
    host.key = null;
    await account.addPasskey();
    expect(account.error).toBe("Your sign-in key isn't loaded in this tab. Sign out of LexiTar and sign in again, then try this.");
    expect(account.errorFor).toBe("passkey");
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
    expect(auth.addPasswordMethod).toHaveBeenCalledWith(EXTRACTABLE, "hunter2hunter2", undefined, undefined);
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
    await vi.waitFor(() => expect(auth.addGoogleMethod).toHaveBeenCalledWith(EXTRACTABLE, undefined, undefined));
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
    await vi.waitFor(() => expect(account.error).toBe("That Google account is already connected to a different LexiTar account."));
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
    expect(account.currentPassword).toBe("");
    expect(account.error).toBeNull();
    expect(account.errorFor).toBeNull();
    expect(account.done).toBeNull();
  });
});

// W73 put a step-up challenge on all three add-method routes: an account with a password must prove
// that password before another way in is minted, because a 30-day session cookie must not be
// convertible into permanent access. The panel never sent the proof. So every one of the three
// returned 401 "enter your current password to add a sign-in method" on every account with a
// password — which on production is every account — and the panel showed that sentence at the foot
// of the modal, beside no password field, because there was none. These tests are the client half of
// `functions/_lib/step-up.ts`, and the only reason the defect could ship is that nothing held it.
describe("proving the current password, which the server has always required", () => {
  it("asks for the proof exactly when the account has a password to be challenged", async () => {
    const { account } = harness();
    await account.openPanel();
    expect(account.stepUpNeeded).toBe(true);

    auth.listMethods.mockResolvedValue([method("google")]);
    const noPassword = harness().account;
    await noPassword.openPanel();
    // Nothing to challenge, so demanding something would block an account that cannot comply —
    // which is the same rule step-up.ts states for its own side.
    expect(noPassword.stepUpNeeded).toBe(false);
  });

  it("sends the proof with the Google link, which is what was 401ing", async () => {
    vi.stubGlobal("open", vi.fn(() => ({}) as Window));
    const { account } = harness();
    await account.openPanel();
    account.currentPassword = "hunter2hunter2";

    account.connectGoogle();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "hd-google-linked" }, origin: window.location.origin }));

    await vi.waitFor(() => expect(auth.addGoogleMethod).toHaveBeenCalledWith(EXTRACTABLE, "hunter2hunter2", "blair@example.com"));
  });

  it("sends the proof with a passkey and with a password", async () => {
    const { account } = harness();
    await account.openPanel();
    account.currentPassword = "hunter2hunter2";
    await account.addPasskey();
    expect(auth.addPasskeyMethod).toHaveBeenCalledWith(EXTRACTABLE, "hunter2hunter2", "blair@example.com");

    account.currentPassword = "hunter2hunter2";
    account.newPassword = "a-second-password";
    await account.addPassword();
    expect(auth.addPasswordMethod).toHaveBeenCalledWith(EXTRACTABLE, "a-second-password", "hunter2hunter2", "blair@example.com");
  });

  it("spends the proof on success and keeps it on failure", async () => {
    const { account } = harness();
    await account.openPanel();

    account.currentPassword = "hunter2hunter2";
    await account.addPasskey();
    // Leaving it in the field would let the next add succeed without the person being present,
    // which is the whole thing the challenge exists to prevent.
    expect(account.currentPassword).toBe("");

    auth.addPasskeyMethod.mockRejectedValue(new Error("that is not your current password"));
    account.currentPassword = "wrong";
    await account.addPasskey();
    expect(account.currentPassword).toBe("wrong");
  });
});

describe("telling the person what happened", () => {
  it("tags each message with the control it belongs to, so it can be shown beside it", async () => {
    const { account } = harness();
    await account.openPanel();

    await account.saveProfile();
    expect(account.doneFor).toBe("profile");
    expect(account.done).toBe("Profile saved.");

    auth.addPasskeyMethod.mockRejectedValue(new Error("nope"));
    account.currentPassword = "hunter2hunter2";
    await account.addPasskey();
    expect(account.errorFor).toBe("passkey");
    // One slot per outcome, cleared on the next attempt: the passkey's failure must not leave the
    // profile's confirmation standing beside the profile form.
    expect(account.done).toBeNull();
  });

  it("confirms a success only after re-reading the server", async () => {
    const { account } = harness();
    await account.openPanel();
    const order: string[] = [];
    auth.addPasskeyMethod.mockImplementation(async () => void order.push("add"));
    auth.listMethods.mockImplementation(async () => {
      order.push("list");
      return [method("password"), method("passkey")];
    });

    account.currentPassword = "hunter2hunter2";
    await account.addPasskey();

    // A confirmation written from "the request did not throw" is the same unearned confidence as a
    // button whose verb flips: it says the server holds something nobody has asked the server about.
    expect(order).toEqual(["add", "list"]);
    expect(account.done).toBe("Passkey added — you can sign in to LexiTar with it.");
  });

  it("reports what the server now holds for recovery, not what a button was pressed", async () => {
    auth.listMethods.mockResolvedValue([method("password"), { method: "recovery", createdAt: "2026-10-17T09:00:00Z", isRecovery: true }]);
    const { account } = harness();
    await account.openPanel();
    expect(account.hasRecovery).toBe(true);
    expect(account.recoverySetAt).toBe("2026-10-17T09:00:00Z");
  });

  it("says so while Google's window is open, and when it is closed without finishing", async () => {
    vi.useFakeTimers();
    try {
      const popup = { closed: false } as Window;
      vi.stubGlobal("open", vi.fn(() => popup));
      const { account } = harness();

      account.connectGoogle();
      // The popup trip is most of the time this action takes; before this the panel looked idle for
      // all of it, which is indistinguishable from a button that did nothing.
      expect(account.pending).toBe("google");
      expect(account.busy).toBe(true);

      (popup as { closed: boolean }).closed = true;
      vi.advanceTimersByTime(600);

      expect(account.pending).toBeNull();
      expect(account.busy).toBe(false);
      expect(account.errorFor).toBe("google");
      expect(account.error).toBe("Google's window closed before the connection finished. Try Connect Google again.");
      expect(auth.addGoogleMethod).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what a browser passkey failure says", () => {
  // The panel shows `error` verbatim, so whatever the browser throws is what a person reads. One of
  // them reached production on 2026-10-17 and ended with a link to the WebAuthn specification's
  // privacy-considerations section, which is a sentence written for a standards reader.
  it("replaces the spec-text DOMException with an instruction", async () => {
    const spec = Object.assign(
      new Error('The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.'),
      { name: "NotAllowedError" },
    );
    auth.addPasskeyMethod.mockRejectedValue(spec);
    const { account } = harness();
    await account.openPanel();
    account.currentPassword = "hunter2hunter2";
    await account.addPasskey();

    expect(account.errorFor).toBe("passkey");
    expect(account.error).toBe(
      "Your device did not confirm the passkey — the prompt was dismissed, or it timed out. Try again and approve it on your device.",
    );
    expect(account.error).not.toMatch(/w3\.org|webauthn-2/);
  });

  it("passes the server's own sentence through untouched", async () => {
    // The host's passkey routes classify their own failures (functions/_lib/webauthn.ts's
    // passkeyVerifyFailure) and @tinytars/vault surfaces that sentence as an Error with no `name`.
    // Rewriting it here would discard the one message that knows what actually happened.
    const fromServer = "Your device did not confirm it was you. Unlock it with your fingerprint, face or PIN, then try again.";
    auth.addPasskeyMethod.mockRejectedValue(new Error(fromServer));
    const { account } = harness();
    await account.openPanel();
    account.currentPassword = "hunter2hunter2";
    await account.addPasskey();
    expect(account.error).toBe(fromServer);
  });

  it("names the host app rather than this package when the address is wrong", () => {
    const e = Object.assign(new Error("x"), { name: "SecurityError" });
    expect(passkeyFailureMessage(e, "Example")).toContain("Example");
  });

  it.each([
    ["InvalidStateError", /already holds a passkey/],
    ["NotSupportedError", /cannot create a passkey/],
    ["AbortError", /cancelled/],
  ])("translates %s", (name, matcher) => {
    expect(passkeyFailureMessage(Object.assign(new Error("ignored"), { name }), "Example")).toMatch(matcher);
  });

  it("never shows an empty message for something it has never seen", () => {
    expect(passkeyFailureMessage({}, "Example")).toMatch(/Nothing changed/);
    expect(passkeyFailureMessage(null, "Example")).toMatch(/Nothing changed/);
  });
});

import { describe, it, expect } from "vitest";
import type { EnteredAccount } from "@tinytars/frame/roster-session.svelte";
import { createAuthFlow, type AuthFlowDeps } from "../../src/lib/auth-flow";

const account = (): EnteredAccount => ({ vaultId: "v1", r2Key: "vaults/v1.enc", privateKey: {} as CryptoKey, dek: null });

function harness(overrides: Partial<AuthFlowDeps> = {}, form = { email: "ana@example.com", password: "pw" }) {
  const calls: string[] = [];
  const state = { unlocking: false, error: null as string | null, googleError: null as string | null, unlockingSeen: [] as boolean[] };
  const deps: AuthFlowDeps = {
    getEmail: () => form.email,
    getPassword: () => form.password,
    setUnlocking: (b) => { state.unlocking = b; state.unlockingSeen.push(b); },
    setError: (m) => (state.error = m),
    setGoogleError: (m) => (state.googleError = m),
    loginPassword: async (e, p) => { calls.push(`loginPassword:${e}:${p}`); return account(); },
    loginPasskey: async (e) => { calls.push(`loginPasskey:${e}`); return account(); },
    signupPassword: async (e, n, p) => { calls.push(`signupPassword:${e}:${n}:${p}`); },
    signupPasskey: async (e, n) => { calls.push(`signupPasskey:${e}:${n}`); },
    bootstrapGoogleSession: async () => { calls.push("bootstrapGoogle"); return account(); },
    persistSessionKey: async () => { calls.push("persist"); },
    enterAccount: async () => { calls.push("enter"); },
    markGoogleResume: () => calls.push("markGoogleResume"),
    ...overrides,
  };
  return { flow: createAuthFlow(deps), calls, state };
}

describe("createAuthFlow.login", () => {
  it("persists the resume key before entering the account", async () => {
    const { flow, calls, state } = harness();
    await flow.login("password");
    expect(calls).toEqual(["loginPassword:ana@example.com:pw", "persist", "enter"]);
    expect(state.unlockingSeen).toEqual([true, false]);
  });

  it("logs in by passkey without needing a password", async () => {
    const { flow, calls } = harness({}, { email: "ana@example.com", password: "" });
    await flow.login("passkey");
    expect(calls).toEqual(["loginPasskey:ana@example.com", "persist", "enter"]);
  });

  it("does nothing when the form is missing what the method needs", async () => {
    const noPassword = harness({}, { email: "ana@example.com", password: "" });
    await noPassword.flow.login("password");
    const noEmail = harness({}, { email: "", password: "pw" });
    await noEmail.flow.login("passkey");
    expect([...noPassword.calls, ...noEmail.calls]).toEqual([]);
    expect(noPassword.state.unlockingSeen).toEqual([]);
  });

  it("surfaces a failed login as the error and never enters", async () => {
    const { flow, calls, state } = harness({ loginPassword: async () => { throw new Error("bad password"); } });
    await flow.login("password");
    expect(state.error).toBe("bad password");
    expect(state.unlocking).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("createAuthFlow.signup", () => {
  it("creates the account named after the email's local part, then logs in and enters", async () => {
    const { flow, calls } = harness();
    await flow.signup("password");
    expect(calls).toEqual(["signupPassword:ana@example.com:ana:pw", "loginPassword:ana@example.com:pw", "persist", "enter"]);
  });

  it("falls back to the whole email when the local part is empty", async () => {
    const { flow, calls } = harness({}, { email: "@example.com", password: "" });
    await flow.signup("passkey");
    expect(calls[0]).toBe("signupPasskey:@example.com:@example.com");
  });

  it("stops before logging in when signup fails", async () => {
    const { flow, calls, state } = harness({ signupPassword: async () => { throw new Error("email taken"); } });
    await flow.signup("password");
    expect(state.error).toBe("email taken");
    expect(calls).toEqual([]);
  });
});

describe("createAuthFlow.handleGoogleReturn", () => {
  it("maps a known error code to its message without touching the session", async () => {
    const { flow, calls, state } = harness();
    await flow.handleGoogleReturn("state");
    expect(state.googleError).toBe("Google sign-in expired or was interrupted. Please try again.");
    expect(state.unlockingSeen).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("falls back to a generic message for an unknown code", async () => {
    const { flow, state } = harness();
    await flow.handleGoogleReturn("weird");
    expect(state.googleError).toBe("Google sign-in failed.");
  });

  it("enters the bootstrapped account and only then marks the session resumable", async () => {
    const { flow, calls } = harness();
    await flow.handleGoogleReturn(null);
    expect(calls).toEqual(["bootstrapGoogle", "enter", "markGoogleResume"]);
  });

  it("does not mark a failed Google entry as resumable", async () => {
    const { flow, calls, state } = harness({ enterAccount: async () => { throw new Error("no vault"); } });
    await flow.handleGoogleReturn(null);
    expect(state.error).toBe("no vault");
    expect(calls).toEqual(["bootstrapGoogle"]);
  });
});

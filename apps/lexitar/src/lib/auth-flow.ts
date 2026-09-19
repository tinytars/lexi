import type { EnteredAccount } from "@tinytars/frame/roster-session.svelte";

export type AuthMethod = "password" | "passkey";

export interface AuthFlowDeps {
  getEmail: () => string;
  getPassword: () => string;
  setUnlocking: (busy: boolean) => void;
  setError: (message: string | null) => void;
  setGoogleError: (message: string) => void;
  loginPassword: (email: string, password: string) => Promise<EnteredAccount>;
  loginPasskey: (email: string) => Promise<EnteredAccount>;
  signupPassword: (email: string, displayName: string, password: string) => Promise<unknown>;
  signupPasskey: (email: string, displayName: string) => Promise<unknown>;
  bootstrapGoogleSession: () => Promise<EnteredAccount>;
  persistSessionKey: (privateKey: CryptoKey) => Promise<void>;
  enterAccount: (account: EnteredAccount) => Promise<void>;
  markGoogleResume: () => void;
}

export interface AuthFlow {
  login(method: AuthMethod): Promise<void>;
  signup(method: AuthMethod): Promise<void>;
  handleGoogleReturn(errorCode: string | null): Promise<void>;
}

const GOOGLE_ERRORS: Record<string, string> = {
  email_exists: "An account with that email already exists. Sign in with your existing method, then add Google from Account settings.",
  state: "Google sign-in expired or was interrupted. Please try again.",
  auth: "Google sign-in failed. Please try again.",
  server: "Something went wrong creating your account. Please try again.",
};

export function createAuthFlow(deps: AuthFlowDeps): AuthFlow {
  async function unlocking(work: () => Promise<void>): Promise<void> {
    deps.setUnlocking(true);
    deps.setError(null);
    try {
      await work();
    } catch (e) {
      deps.setError((e as Error).message);
    } finally {
      deps.setUnlocking(false);
    }
  }

  function missingCredentials(method: AuthMethod): boolean {
    return !deps.getEmail() || (method === "password" && !deps.getPassword());
  }

  function authenticate(method: AuthMethod): Promise<EnteredAccount> {
    return method === "password" ? deps.loginPassword(deps.getEmail(), deps.getPassword()) : deps.loginPasskey(deps.getEmail());
  }

  // W49 — the resume key is persisted before entering: entering paints the app, and a refresh in that
  // window would otherwise beat the IndexedDB write and bounce to the lock screen.
  async function enter(account: EnteredAccount): Promise<void> {
    await deps.persistSessionKey(account.privateKey);
    await deps.enterAccount(account);
  }

  async function login(method: AuthMethod): Promise<void> {
    if (missingCredentials(method)) return;
    await unlocking(async () => enter(await authenticate(method)));
  }

  async function signup(method: AuthMethod): Promise<void> {
    if (missingCredentials(method)) return;
    await unlocking(async () => {
      const email = deps.getEmail();
      const displayName = email.split("@")[0] || email;
      await (method === "password" ? deps.signupPassword(email, displayName, deps.getPassword()) : deps.signupPasskey(email, displayName));
      await enter(await authenticate(method));
    });
  }

  async function handleGoogleReturn(errorCode: string | null): Promise<void> {
    if (errorCode) {
      deps.setGoogleError(GOOGLE_ERRORS[errorCode] ?? "Google sign-in failed.");
      return;
    }
    await unlocking(async () => {
      await deps.enterAccount(await deps.bootstrapGoogleSession());
      deps.markGoogleResume();
    });
  }

  return { login, signup, handleGoogleReturn };
}

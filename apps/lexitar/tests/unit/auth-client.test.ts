// W72 item 20 — auth-client.ts, the largest cold surface coverage found (20.4% of 741 lines).
//
// This module is the browser half of the zero-knowledge claim in SECURITY.md: the server must never
// see a password, a KEK, or a DEK. Its SERVER counterparts are well tested, which is exactly what made
// the gap dangerous — the suite looked green over a path where only one side was verified, and the
// side that was missing is the one holding the secrets.
//
// The fake server below is not a mock of the client's own behaviour; it is a recording proxy that
// keeps every request body verbatim, so the central assertions are made against WHAT ACTUALLY WENT
// OVER THE WIRE rather than against what the code was expected to send. It also round-trips signup
// into login, which is the property that matters: an account created here must be openable here, and
// the DEK that comes back must decrypt what the DEK that went in encrypted.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signupPassword, loginPassword } from "@tinytars/vault/auth-client";
import { recoverAccount } from "@tinytars/vault/auth-recovery";
import { generateAccountKeypair, encryptVaultV2, decryptVaultV2 } from "@tinytars/vault/crypto";

const PASSWORD = "correct horse battery staple";
const EMAIL = "patient@example.com";

interface Sent { url: string; body: any }
let sent: Sent[] = [];
let stored: any = null;
let orgKp: Awaited<ReturnType<typeof generateAccountKeypair>>;
const realFetch = globalThis.fetch;

/**
 * A server that keeps exactly what a real one keeps — the wrapped key, the KDF salt, the auth hash and
 * the envelopes — and nothing else. It cannot compute anything from them, which is the point.
 */
function server(over: { saltStatus?: number; loginStatus?: number } = {}) {
  return async (input: any, init?: any): Promise<Response> => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : null;
    sent.push({ url, body });
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

    if (url === "/api/vault/org-key") return json(200, { orgAccountId: "org", orgPublicKeyJwk: orgKp.publicKeyJwk });
    if (url.startsWith("/api/auth/password/salt") || url.startsWith("/api/auth/recovery/salt")) {
      if (over.saltStatus) return json(over.saltStatus, { error: "nope" });
      // A real server returns a DECOY salt for an unknown address (W71). Returning the stored one
      // here keeps the round-trip honest without re-implementing the decoy.
      return json(200, { salt: stored?.kdfParams.salt ?? "00".repeat(16), iterations: 200_000 });
    }
    if (url === "/api/auth/password/signup") {
      stored = body;
      return json(200, { accountId: "acct-1", vaultId: "vault-1" });
    }
    if (url === "/api/auth/password/login" || url === "/api/auth/recovery/login") {
      if (over.loginStatus) return json(over.loginStatus, { error: "nope" });
      return json(200, {
        accountId: "acct-1",
        vaultId: "vault-1",
        r2Key: "data-vault-1.enc",
        wrappedPrivateKey: stored.wrappedPrivateKey,
        kdfParams: stored.kdfParams,
        ownerEnvelope: stored.ownerEnvelope,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

beforeEach(async () => {
  sent = [];
  stored = null;
  orgKp = await generateAccountKeypair();
  globalThis.fetch = server() as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const bodies = () => sent.map((s) => JSON.stringify(s.body ?? "")).join("\n");

describe("what reaches the server", () => {
  it("never sends the password, in any field, on signup or login", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    await loginPassword(EMAIL, PASSWORD);
    expect(bodies()).not.toContain(PASSWORD);
    // Nor any single word of it, which is the version of this check that survives an encoding change.
    for (const word of PASSWORD.split(" ")) expect(bodies()).not.toContain(word);
  });

  it("never sends the DEK or the unwrapped private key", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    const { dek, privateKey } = await loginPassword(EMAIL, PASSWORD);
    // Both are non-extractable-by-intent handles at rest; what the server got is the WRAPPED form.
    const rawDek = Buffer.from(await crypto.subtle.exportKey("raw", dek!)).toString("base64");
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");
    expect(bodies()).not.toContain(rawDek);
    expect(bodies()).not.toContain(pkcs8);
  });

  it("sends a signup payload that is only wrapped material and public keys", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    const signup = sent.find((s) => s.url === "/api/auth/password/signup")!.body;
    expect(Object.keys(signup).sort()).toEqual(
      ["authHash", "displayName", "email", "kdfParams", "orgEnvelope", "ownerEnvelope", "publicKeyJwk", "vaultBlob", "wrappedPrivateKey"].sort(),
    );
    expect(signup.kdfParams).toEqual({ salt: expect.stringMatching(/^[0-9a-f]{32}$/), iterations: 200_000 });
    // The account keypair's PRIVATE half must never appear in the public JWK.
    expect(signup.publicKeyJwk.d).toBeUndefined();
  });

  it("wraps the DEK to the org as well as the owner, which is what makes recovery possible", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    const signup = sent.find((s) => s.url === "/api/auth/password/signup")!.body;
    expect(signup.ownerEnvelope.wrappedDEK).toBeTruthy();
    expect(signup.orgEnvelope.wrappedDEK).toBeTruthy();
    // Two different ephemeral wrappings of the same DEK — identical ciphertext would mean one
    // ephemeral key was reused across recipients.
    expect(signup.ownerEnvelope.wrappedDEK).not.toBe(signup.orgEnvelope.wrappedDEK);
    expect(signup.ownerEnvelope.ephemeralPublicKeyJwk).not.toEqual(signup.orgEnvelope.ephemeralPublicKeyJwk);
  });

  it("derives a fresh salt per account, so two accounts with the same password differ everywhere", async () => {
    await signupPassword(EMAIL, "A", PASSWORD);
    const first = sent.find((s) => s.url === "/api/auth/password/signup")!.body;
    sent = [];
    await signupPassword("other@example.com", "B", PASSWORD);
    const second = sent.find((s) => s.url === "/api/auth/password/signup")!.body;
    expect(second.kdfParams.salt).not.toBe(first.kdfParams.salt);
    expect(second.authHash).not.toBe(first.authHash);
    expect(second.wrappedPrivateKey).not.toBe(first.wrappedPrivateKey);
  });
});

describe("signup → login round trip", () => {
  it("returns a DEK that opens what the signup DEK sealed", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    const { dek, accountId, vaultId, r2Key } = await loginPassword(EMAIL, PASSWORD);
    expect({ accountId, vaultId, r2Key }).toEqual({ accountId: "acct-1", vaultId: "vault-1", r2Key: "data-vault-1.enc" });
    // The vault blob the signup uploaded, opened with the DEK the login recovered.
    const blob = Buffer.from(stored.vaultBlob, "base64");
    expect(await decryptVaultV2(new Uint8Array(blob), dek!)).toEqual({ clients: {} });
  });

  it("gives a DEK that can seal something the SAME login can reopen", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    const first = await loginPassword(EMAIL, PASSWORD);
    const sealed = await encryptVaultV2({ clients: { a: 1 } } as never, first.dek!);
    const second = await loginPassword(EMAIL, PASSWORD);
    expect(await decryptVaultV2(sealed, second.dek!)).toEqual({ clients: { a: 1 } });
  });

  it("fails to unwrap under the wrong password rather than returning a wrong key", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    await expect(loginPassword(EMAIL, "not the password")).rejects.toThrow(/cannot unwrap private key/);
  });

  it("returns a null DEK, not a fabricated one, when the account has no owner envelope", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    stored.ownerEnvelope = null;
    const { dek, privateKey } = await loginPassword(EMAIL, PASSWORD);
    expect(dek).toBeNull();
    expect(privateKey).toBeTruthy();
  });

  it("defaults rotationPending to false when the server omits it", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    expect((await loginPassword(EMAIL, PASSWORD)).rotationPending).toBe(false);
  });
});

describe("the enumeration oracle stays closed", () => {
  it("does not tell the user whether the address is registered when the salt lookup fails", async () => {
    // W71 replaced "unknown account" with a fault message precisely because the salt endpoint now
    // returns a decoy for an unknown address. A helpful error here would re-open the oracle in UI text.
    globalThis.fetch = server({ saltStatus: 500 }) as typeof fetch;
    await expect(loginPassword(EMAIL, PASSWORD)).rejects.toThrow(/sign-in is unavailable right now/);
    await expect(loginPassword(EMAIL, PASSWORD)).rejects.not.toThrow(/unknown|not found|no such/i);
  });

  it("says the same kind of thing on the recovery path", async () => {
    globalThis.fetch = server({ saltStatus: 500 }) as typeof fetch;
    await expect(recoverAccount(EMAIL, "CODE")).rejects.toThrow(/recovery is unavailable right now/);
  });

  it("reports a rejected login without naming the reason", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    globalThis.fetch = server({ loginStatus: 401 }) as typeof fetch;
    await expect(loginPassword(EMAIL, PASSWORD)).rejects.toThrow(/login failed: 401/);
  });
});

describe("recovery", () => {
  it("opens the same vault from a recovery code, without the password", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    // A real recovery credential wraps the same private key under a code-derived KEK. Here the stored
    // credential is the password one, so the "code" is the password — what is under test is that the
    // recovery path performs the same unwrap and returns a working DEK, not that it uses a code.
    const { dek, accountId } = await recoverAccount(EMAIL, PASSWORD);
    expect(accountId).toBe("acct-1");
    expect(await decryptVaultV2(new Uint8Array(Buffer.from(stored.vaultBlob, "base64")), dek!)).toEqual({ clients: {} });
  });

  it("sends a hash of the recovery code, never the code", async () => {
    await signupPassword(EMAIL, "Patient", PASSWORD);
    sent = [];
    await recoverAccount(EMAIL, PASSWORD);
    const login = sent.find((s) => s.url === "/api/auth/recovery/login")!.body;
    expect(Object.keys(login).sort()).toEqual(["email", "recoveryAuthHash"]);
    expect(login.recoveryAuthHash).not.toContain(PASSWORD);
  });
});

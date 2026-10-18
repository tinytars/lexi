// Attaching a passkey mints a permanent credential on an existing account, so a stolen cookie must not
// suffice. The ceremony is mocked at @simplewebauthn (no headless authenticator); everything else is real.

import { describe, it, expect, vi } from "vitest";

// The options the route hands the library are kept, because one of them is the production bug this
// suite now pins: the library's requireUserVerification defaults to true while our own registration
// options ask only that user verification be "preferred".
const seen = vi.hoisted(() => ({ opts: null as null | Record<string, unknown> }));

vi.mock("@simplewebauthn/server", () => ({
  verifyRegistrationResponse: vi.fn(async (opts: { response: { id: string } }) => {
    seen.opts = opts as unknown as Record<string, unknown>;
    // The library THROWS rather than returning verified:false for a failed expectation. This is the
    // real message production threw on 2026-10-17 (plover-factory#65).
    if (opts.response.id === "uv-unverified") throw new Error("User verification was required, but user could not be verified");
    if (opts.response.id === "stale-challenge") throw new Error("Unexpected registration response challenge");
    return {
      verified: opts.response.id !== "unverifiable",
      registrationInfo:
        opts.response.id === "unverifiable"
          ? undefined
          : { credential: { id: opts.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 } },
    };
  }),
}));

import { onRequestPost as verifyAddPasskey } from "../../functions/api/account/methods/passkey/verify";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { addIdentity, getCredential, putCredential } from "../../functions/_lib/identity-credentials";
import { setChallengeCookie, passkeyVerifyFailure } from "../../functions/_lib/webauthn";
import { sha256Base64Url } from "../../functions/_lib/verifier";
import { generateAccountKeypair, deriveKekFromPassword, wrapPrivateKey, deriveAuthHash } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const KDF_ITERATIONS = 200_000;
const w = useWorkerd();

const env = () => ({ DB: w.db, SESSION_SECRET, WEBAUTHN_RP_ID: "localhost", WEBAUTHN_RP_NAME: "LexiTar", WEBAUTHN_ORIGIN: "http://localhost:8788" }) as any;
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function bareAccount() {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: "A", email: `${id}@x.test` });
  return id;
}

async function accountWithPassword(password: string) {
  const id = await bareAccount();
  const { privateKey } = await generateAccountKeypair();
  const salt = rand(16);
  await putCredential(w.db, {
    accountId: id,
    method: "password",
    wrappedPrivateKey: await wrapPrivateKey(privateKey, await deriveKekFromPassword(password, salt)),
    kdfParams: { salt: hex(salt), iterations: KDF_ITERATIONS, authHashSha256: await sha256Base64Url(await deriveAuthHash(password, salt)) },
  });
  await addIdentity(w.db, { accountId: id, method: "password" });
  return { id, authHash: await deriveAuthHash(password, salt) };
}

async function call(opts: { accountId?: string; challengeFor?: string; body?: Record<string, unknown> }) {
  const cookies: string[] = [];
  if (opts.accountId) cookies.push(await cookieFor(opts.accountId));
  if (opts.challengeFor) {
    const set = await setChallengeCookie(env(), { challenge: "chal", email: opts.challengeFor, prfSalt: "ab".repeat(16) });
    cookies.push(set.split(";")[0]);
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookies.length) headers.cookie = cookies.join("; ");
  return verifyAddPasskey({
    request: new Request("http://x/api/account/methods/passkey/verify", {
      method: "POST",
      headers,
      body: JSON.stringify({
        attestationResponse: { id: `cred-${crypto.randomUUID()}` },
        wrappedPrivateKey: btoa("wrapped"),
        prfSaltHex: "ab".repeat(16),
        ...opts.body,
      }),
    }),
    env: env(),
  });
}

describe("adding a passkey to an existing account", () => {
  it("refuses without a session — the credential it mints is permanent", async () => {
    expect((await call({ challengeFor: "a@x.test" })).status).toBe(401);
  });

  it("refuses without the challenge cookie, so an attestation cannot be replayed on its own", async () => {
    const id = await bareAccount();
    const res = await call({ accountId: id });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/challenge/);
  });

  it("refuses a body missing the wrapped key, before it touches the ceremony", async () => {
    const id = await bareAccount();
    const res = await call({ accountId: id, challengeFor: "a@x.test", body: { wrappedPrivateKey: undefined } });
    expect(res.status).toBe(400);
  });

  it("attaches the passkey to THIS account and nobody else, and clears the challenge", async () => {
    const mine = await bareAccount();
    const theirs = await bareAccount();
    const res = await call({ accountId: mine, challengeFor: "a@x.test" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");

    expect(await getCredential(w.db, mine, "passkey")).toBeTruthy();
    expect(await getCredential(w.db, theirs, "passkey")).toBeNull();
  });

  it("stores the browser's wrapped key verbatim and NEVER a PRF secret or KEK", async () => {
    const id = await bareAccount();
    await call({ accountId: id, challengeFor: "a@x.test", body: { wrappedPrivateKey: btoa("the-wrapped-account-key"), prfSaltHex: "cd".repeat(16) } });

    const cred = (await getCredential(w.db, id, "passkey")) as any;
    expect(new TextDecoder().decode(cred.wrappedPrivateKey)).toBe("the-wrapped-account-key");
    // The salt is public and the credential is public; nothing derived from the authenticator's PRF
    // output may be here, because the server is never supposed to be able to unwrap this key.
    expect(cred.kdfParams.prfSalt).toBe("cd".repeat(16));
    expect(JSON.stringify(cred.kdfParams)).not.toContain("prfSecret");
    expect(cred.kdfParams.kek).toBeUndefined();
  });

  it("refuses a second passkey rather than overwriting the first", async () => {
    const id = await bareAccount();
    expect((await call({ accountId: id, challengeFor: "a@x.test" })).status).toBe(200);
    const res = await call({ accountId: id, challengeFor: "a@x.test" });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toMatch(/already set/);
  });

  it("refuses when the ceremony does not verify, and writes nothing", async () => {
    const id = await bareAccount();
    const res = await call({ accountId: id, challengeFor: "a@x.test", body: { attestationResponse: { id: "unverifiable" } } });
    expect(res.status).toBe(400);
    expect(await getCredential(w.db, id, "passkey")).toBeNull();
  });

  // The library's own default refused a device our registration options had invited, and because the
  // call sat outside any try the person got a 500 reading "internal error" beside the button.
  it("does not require user verification the options only preferred", async () => {
    const id = await bareAccount();
    expect((await call({ accountId: id, challengeFor: "a@x.test" })).status).toBe(200);
    expect(seen.opts?.requireUserVerification).toBe(false);
  });

  it("answers a THROWN verification with a sentence and a code, not a 500", async () => {
    const id = await bareAccount();
    const res = await call({ accountId: id, challengeFor: "a@x.test", body: { attestationResponse: { id: "uv-unverified" } } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errorCode: string };
    expect(body.errorCode).toBe("uv_unverified");
    // What the panel shows: an instruction, not a dead end.
    expect(body.error).toMatch(/fingerprint, face or PIN/);
    expect(body.error).not.toMatch(/internal error/);
    expect(await getCredential(w.db, id, "passkey")).toBeNull();
  });

  it("tells an expired challenge apart from a refused one", async () => {
    const id = await bareAccount();
    const res = await call({ accountId: id, challengeFor: "a@x.test", body: { attestationResponse: { id: "stale-challenge" } } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe("challenge_mismatch");
  });
});

// Classification is by the library's message, so it is pinned where a dependency bump would break it.
describe("passkeyVerifyFailure", () => {
  it.each([
    ["User verification was required, but user could not be verified", "uv_unverified"],
    ["Unexpected registration response challenge", "challenge_mismatch"],
    ['Unexpected registration response origin "https://a.test", expected "https://b.test"', "host_mismatch"],
    ["Unexpected RP ID hash", "host_mismatch"],
    ["Unsupported Attestation Format: tpm", "attestation_rejected"],
  ])("classifies %s", (message, errorCode) => {
    expect(passkeyVerifyFailure(new Error(message)).errorCode).toBe(errorCode);
  });

  it("carries a message for a cause it has never seen, and never the empty string", () => {
    const { errorCode, message } = passkeyVerifyFailure("not even an Error");
    expect(errorCode).toBe("attestation_rejected");
    expect(message.length).toBeGreaterThan(20);
  });
});

// A stolen cookie alone must not mint a credential that outlives it.
describe("the step-up challenge", () => {
  it("refuses when the account HAS a password and the request does not prove it", async () => {
    const { id } = await accountWithPassword("correct horse battery");
    const res = await call({ accountId: id, challengeFor: "a@x.test" });
    expect(res.status).toBe(401);
    expect(await getCredential(w.db, id, "passkey")).toBeNull();
  });

  it("refuses a WRONG proof as firmly as a missing one", async () => {
    const { id } = await accountWithPassword("correct horse battery");
    const res = await call({ accountId: id, challengeFor: "a@x.test", body: { currentAuthHash: "not-the-hash" } });
    expect(res.status).toBe(401);
    expect(await getCredential(w.db, id, "passkey")).toBeNull();
  });

  it("accepts the right proof", async () => {
    const { id, authHash } = await accountWithPassword("correct horse battery");
    const res = await call({ accountId: id, challengeFor: "a@x.test", body: { currentAuthHash: authHash } });
    expect(res.status).toBe(200);
    expect(await getCredential(w.db, id, "passkey")).toBeTruthy();
  });

  it("allows an account with NO password through — there is nothing it could prove", async () => {
    const id = await bareAccount();
    expect((await call({ accountId: id, challengeFor: "a@x.test" })).status).toBe(200);
  });
});

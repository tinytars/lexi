// W75 item 14 — /api/account/methods/passkey/verify, the route that ATTACHES a new passkey to an
// existing account.
//
// It had no test of its own. passkey-function.test.ts covers the `api/auth/passkey/**` siblings —
// signup and login — which are a different question: those create or open an account, this one mints
// a permanent credential ON one that already exists. An authorization defect here is silent account
// takeover, and it outlives the cookie that caused it, which is the whole reason W73 put a step-up in
// front of it. The ceremony is mocked at the @simplewebauthn boundary (a real one cannot run
// headless); the session gate, the step-up, the challenge cookie and every D1 write are real.

import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Miniflare } from "miniflare";

vi.mock("@simplewebauthn/server", () => ({
  verifyRegistrationResponse: vi.fn(async (opts: { response: { id: string } }) => ({
    verified: opts.response.id !== "unverifiable",
    registrationInfo:
      opts.response.id === "unverifiable"
        ? undefined
        : { credential: { id: opts.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 } },
  })),
}));

import { onRequestPost as verifyAddPasskey } from "../../functions/api/account/methods/passkey/verify";
import type { D1Database } from "../../functions/_lib/identity-types";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { addIdentity, getCredential, putCredential } from "../../functions/_lib/identity-credentials";
import { signSession } from "../../functions/_lib/session";
import { setChallengeCookie } from "../../functions/_lib/webauthn";
import { sha256Base64Url } from "../../functions/_lib/verifier";
import { generateAccountKeypair, deriveKekFromPassword, wrapPrivateKey, deriveAuthHash } from "@tinytars/vault/crypto";

const SECRET = "test-secret";
const KDF_ITERATIONS = 200_000;
let mf: Miniflare;
let db: any;

beforeEach(async () => {
  await mf?.dispose();
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: `test-add-passkey-${crypto.randomUUID()}` },
  });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as D1Database);
});
afterAll(async () => { await mf.dispose(); });

const env = () => ({ DB: db, SESSION_SECRET: SECRET, WEBAUTHN_RP_ID: "localhost", WEBAUTHN_RP_NAME: "LexiTar", WEBAUTHN_ORIGIN: "http://localhost:8788" }) as any;
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function bareAccount() {
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "A", email: `${id}@x.test` });
  return id;
}

async function accountWithPassword(password: string) {
  const id = await bareAccount();
  const { privateKey } = await generateAccountKeypair();
  const salt = rand(16);
  await putCredential(db, {
    accountId: id,
    method: "password",
    wrappedPrivateKey: await wrapPrivateKey(privateKey, await deriveKekFromPassword(password, salt)),
    kdfParams: { salt: hex(salt), iterations: KDF_ITERATIONS, authHashSha256: await sha256Base64Url(await deriveAuthHash(password, salt)) },
  });
  await addIdentity(db, { accountId: id, method: "password" });
  return { id, authHash: await deriveAuthHash(password, salt) };
}

async function call(opts: { accountId?: string; challengeFor?: string; body?: Record<string, unknown> }) {
  const cookies: string[] = [];
  if (opts.accountId) cookies.push(`hd_session=${await signSession({ SESSION_SECRET: SECRET }, opts.accountId)}`);
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

    expect(await getCredential(db, mine, "passkey")).toBeTruthy();
    expect(await getCredential(db, theirs, "passkey")).toBeNull();
  });

  it("stores the browser's wrapped key verbatim and NEVER a PRF secret or KEK", async () => {
    const id = await bareAccount();
    await call({ accountId: id, challengeFor: "a@x.test", body: { wrappedPrivateKey: btoa("the-wrapped-account-key"), prfSaltHex: "cd".repeat(16) } });

    const cred = (await getCredential(db, id, "passkey")) as any;
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
    expect(await getCredential(db, id, "passkey")).toBeNull();
  });
});

// W73 gap 5, from this route's side: a stolen cookie alone must not mint a credential that outlives it.
describe("the step-up challenge", () => {
  it("refuses when the account HAS a password and the request does not prove it", async () => {
    const { id } = await accountWithPassword("correct horse battery");
    const res = await call({ accountId: id, challengeFor: "a@x.test" });
    expect(res.status).toBe(401);
    expect(await getCredential(db, id, "passkey")).toBeNull();
  });

  it("refuses a WRONG proof as firmly as a missing one", async () => {
    const { id } = await accountWithPassword("correct horse battery");
    const res = await call({ accountId: id, challengeFor: "a@x.test", body: { currentAuthHash: "not-the-hash" } });
    expect(res.status).toBe(401);
    expect(await getCredential(db, id, "passkey")).toBeNull();
  });

  it("accepts the right proof", async () => {
    const { id, authHash } = await accountWithPassword("correct horse battery");
    const res = await call({ accountId: id, challengeFor: "a@x.test", body: { currentAuthHash: authHash } });
    expect(res.status).toBe(200);
    expect(await getCredential(db, id, "passkey")).toBeTruthy();
  });

  it("allows an account with NO password through — there is nothing it could prove", async () => {
    const id = await bareAccount();
    expect((await call({ accountId: id, challengeFor: "a@x.test" })).status).toBe(200);
  });
});

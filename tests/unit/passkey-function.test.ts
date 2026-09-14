import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Miniflare } from "miniflare";

// W44 P3 — real WebAuthn ceremonies can't run headless in vitest, so @simplewebauthn/server is
// mocked at the ceremony-verification boundary. Everything else (D1 rows, R2 blob, session/
// challenge cookies, the PRF-secret↔KEK crypto) is real; the PRF↔KEK round-trip itself is
// already covered by crypto.test.ts (kekFromPrfSecret + wrap/unwrap), so this file only needs
// the ceremony wiring + DB/session side-effects.
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: vi.fn(async (opts: { rpID: string; rpName: string; userName: string; extensions?: unknown }) => ({
    challenge: "test-registration-challenge",
    rp: { id: opts.rpID, name: opts.rpName },
    user: { id: "test-user-id", name: opts.userName, displayName: opts.userName },
    pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    extensions: opts.extensions,
  })),
  // Echoes back the caller's own credential id (like a real authenticator would) rather than a
  // fixed constant — the identities table has a UNIQUE index on credential_id, so a fixed id
  // across every test's registration would collide.
  verifyRegistrationResponse: vi.fn(async (opts: { response: { id: string } }) => ({
    verified: true,
    registrationInfo: {
      credential: { id: opts.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
    },
  })),
  generateAuthenticationOptions: vi.fn(async (opts: { rpID: string; allowCredentials?: unknown; extensions?: unknown }) => ({
    challenge: "test-authentication-challenge",
    rpId: opts.rpID,
    allowCredentials: opts.allowCredentials,
    extensions: opts.extensions,
  })),
  verifyAuthenticationResponse: vi.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })),
}));

import { onRequestPost as registerOptions } from "../../functions/api/auth/passkey/register/options";
import { onRequestPost as registerVerify } from "../../functions/api/auth/passkey/register/verify";
import { onRequestPost as loginOptions } from "../../functions/api/auth/passkey/login/options";
import { onRequestPost as loginVerify } from "../../functions/api/auth/passkey/login/verify";
import { createAccount, getAccountByEmail } from "../../functions/_lib/identity-accounts";
import { getCredential, getIdentityByCredentialId } from "../../functions/_lib/identity-credentials";
import { getEnvelope, listEnvelopesForVault, listVaultsForOwner } from "../../functions/_lib/identity-vault";
import { ORG_ACCOUNT_ID } from "../../functions/_lib/org";
import { generateAccountKeypair, wrapPrivateKey, generateDEK, encryptVaultV2, wrapDEKForPublicKey, kekFromPrfSecret } from "@tinytars/vault/crypto";

let mf: Miniflare;
let db: any; // D1Database
let orgPublicKeyJwk: JsonWebKey;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-passkey" },
  });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
  // W55 P4 — register/verify now writes a second envelope to ORG_ACCOUNT_ID; the FK on
  // vault_envelopes.principal_account_id requires the row to exist first.
  await createAccount(db, { id: ORG_ACCOUNT_ID, displayName: "Org" });
  orgPublicKeyJwk = (await generateAccountKeypair()).publicKeyJwk;
});

afterAll(async () => {
  await mf.dispose();
});

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeEnv(store: Map<string, Uint8Array>) {
  return {
    DB: db,
    VAULT: {
      put: async (k: string, v: Uint8Array) => {
        store.set(k, new Uint8Array(v));
      },
    },
    STORE_PREFIX: "test",
    SESSION_SECRET: "test-secret",
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_RP_NAME: "LexiTar",
    WEBAUTHN_ORIGIN: "http://localhost:8788",
  };
}

function postJson(url: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

// A real Set-Cookie header looks like "name=value; HttpOnly; ...". Requests only want "name=value".
function cookieValue(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error("missing set-cookie header");
  return setCookieHeader.split(";")[0];
}

// Drives the real browser-side crypto primitives (src/lib/crypto.ts) to build a register/verify
// body, standing in for a would-be `attestationResponse.clientExtensionResults.prf.results.first`
// (the mocked authenticator's "PRF secret" is just a fixed 32-byte buffer here). `credId` must be
// distinct per registered account — identities.credential_id is UNIQUE, same as real credentials.
async function buildRegisterVerifyBody(prfSecretFill: number, prfSaltHex: string, credId: string) {
  const prfSecret = new Uint8Array(32).fill(prfSecretFill);
  const kek = await kekFromPrfSecret(prfSecret);
  const { publicKeyJwk, privateKey } = await generateAccountKeypair();
  const wrappedPrivateKey = await wrapPrivateKey(privateKey, kek);
  const dek = await generateDEK();
  const vaultBlob = await encryptVaultV2({ clients: {} }, dek);
  const ownerEnvelope = await wrapDEKForPublicKey(dek, publicKeyJwk);
  const orgEnvelope = await wrapDEKForPublicKey(dek, orgPublicKeyJwk);

  return {
    attestationResponse: {
      id: credId,
      rawId: credId,
      response: { clientDataJSON: "e30", attestationObject: "e30" },
      clientExtensionResults: {},
      type: "public-key",
    },
    publicKeyJwk,
    wrappedPrivateKey: bytesToBase64(wrappedPrivateKey),
    vaultBlob: bytesToBase64(vaultBlob),
    ownerEnvelope: {
      wrappedDEK: bytesToBase64(ownerEnvelope.wrappedDEK),
      ephemeralPublicKeyJwk: ownerEnvelope.ephemeralPublicKeyJwk,
    },
    orgEnvelope: {
      wrappedDEK: bytesToBase64(orgEnvelope.wrappedDEK),
      ephemeralPublicKeyJwk: orgEnvelope.ephemeralPublicKeyJwk,
    },
    prfSaltHex,
  };
}

describe("POST /api/auth/passkey/register", () => {
  it("options sets a signed challenge cookie", async () => {
    const env = makeEnv(new Map());
    const res = await registerOptions({
      request: postJson("http://x/o", { email: "opts@example.com", displayName: "Opts" }),
      env,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^hd_webauthn_chal=/);
  });

  it("options 409s on a duplicate email", async () => {
    const env = makeEnv(new Map());
    const chal = cookieValue(
      (await registerOptions({ request: postJson("http://x/o", { email: "dup@example.com", displayName: "Dup" }), env })).headers.get(
        "set-cookie"
      )
    );
    await registerVerify({
      request: postJson("http://x/v", await buildRegisterVerifyBody(9, bytesToHex(new Uint8Array(16).fill(9)), "cred-dup"), chal),
      env,
    });

    const res = await registerOptions({ request: postJson("http://x/o", { email: "dup@example.com", displayName: "Dup" }), env });
    expect(res.status).toBe(409);
  });

  it("verify 200s, persists account/identity/credential/vault/envelope rows, stores the R2 blob, sets a session cookie, and clears the challenge cookie", async () => {
    const store = new Map<string, Uint8Array>();
    const env = makeEnv(store);
    const optRes = await registerOptions({ request: postJson("http://x/o", { email: "reg@example.com", displayName: "Reg" }), env });
    const chalCookie = cookieValue(optRes.headers.get("set-cookie"));

    const prfSaltHex = bytesToHex(new Uint8Array(16).fill(7));
    const body = await buildRegisterVerifyBody(1, prfSaltHex, "cred-reg");
    const res = await registerVerify({ request: postJson("http://x/v", body, chalCookie), env });
    expect(res.status).toBe(200);

    const setCookies = res.headers.get("set-cookie") ?? "";
    expect(setCookies).toMatch(/hd_session=/);
    expect(setCookies).toMatch(/hd_webauthn_chal=;/);

    const { accountId, vaultId } = (await res.json()) as { accountId: string; vaultId: string };

    const account = await getAccountByEmail(db, "reg@example.com");
    expect(account?.id).toBe(accountId);

    const idn = await getIdentityByCredentialId(db, "cred-reg");
    expect(idn?.accountId).toBe(accountId);

    const cred = await getCredential(db, accountId, "passkey");
    expect(cred).not.toBeNull();
    const kdf = cred!.kdfParams as { prfSalt: string; credentialID: string; counter: number };
    expect(kdf.prfSalt).toBe(prfSaltHex);
    expect(kdf.credentialID).toBe("cred-reg");
    expect(kdf.counter).toBe(0);

    const vaults = await listVaultsForOwner(db, accountId);
    expect(vaults.map((v) => v.vaultId)).toEqual([vaultId]);
    expect(store.has(`test/${vaults[0].r2Key}`)).toBe(true);

    const envelope = await getEnvelope(db, vaultId, accountId);
    expect(envelope).not.toBeNull();

    // W55 P4 — register/verify mints exactly two envelopes: the owner's and the org-recovery one.
    const envelopes = await listEnvelopesForVault(db, vaultId);
    expect(envelopes.map((e) => e.principalAccountId).sort()).toEqual([accountId, ORG_ACCOUNT_ID].sort());
  });

  it("verify 400s when orgEnvelope is missing", async () => {
    const env = makeEnv(new Map());
    const optRes = await registerOptions({ request: postJson("http://x/o", { email: "noorg@example.com", displayName: "NoOrg" }), env });
    const chalCookie = cookieValue(optRes.headers.get("set-cookie"));

    const body = await buildRegisterVerifyBody(8, bytesToHex(new Uint8Array(16).fill(8)), "cred-noorg");
    delete (body as { orgEnvelope?: unknown }).orgEnvelope;
    const res = await registerVerify({ request: postJson("http://x/v", body, chalCookie), env });
    expect(res.status).toBe(400);
  });

  it("verify 400s with a missing challenge cookie", async () => {
    const env = makeEnv(new Map());
    const body = await buildRegisterVerifyBody(2, bytesToHex(new Uint8Array(16).fill(2)), "cred-nochal");
    const res = await registerVerify({ request: postJson("http://x/v", body), env });
    expect(res.status).toBe(400);
  });

  it("verify 400s with a tampered challenge cookie", async () => {
    const env = makeEnv(new Map());
    const optRes = await registerOptions({ request: postJson("http://x/o", { email: "tamper@example.com", displayName: "T" }), env });
    const chalCookie = cookieValue(optRes.headers.get("set-cookie")) + "tampered";

    const body = await buildRegisterVerifyBody(3, bytesToHex(new Uint8Array(16).fill(3)), "cred-tamper");
    const res = await registerVerify({ request: postJson("http://x/v", body, chalCookie), env });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/passkey/login", () => {
  it("options 404s for an unknown email", async () => {
    const env = makeEnv(new Map());
    const res = await loginOptions({ request: postJson("http://x/lo", { email: "nobody@example.com" }), env });
    expect(res.status).toBe(404);
  });

  it("options 200s and sets a challenge cookie for a known passkey account", async () => {
    const env = makeEnv(new Map());
    const chal = cookieValue(
      (await registerOptions({ request: postJson("http://x/o", { email: "log@example.com", displayName: "Log" }) , env })).headers.get(
        "set-cookie"
      )
    );
    await registerVerify({
      request: postJson("http://x/v", await buildRegisterVerifyBody(4, bytesToHex(new Uint8Array(16).fill(4)), "cred-log"), chal),
      env,
    });

    const res = await loginOptions({ request: postJson("http://x/lo", { email: "log@example.com" }), env });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^hd_webauthn_chal=/);
  });

  it("verify happy path 200s, returns the wrapped material, and persists the bumped counter", async () => {
    const env = makeEnv(new Map());
    const regChal = cookieValue(
      (await registerOptions({ request: postJson("http://x/o", { email: "full@example.com", displayName: "Full" }), env })).headers.get(
        "set-cookie"
      )
    );
    const prfSaltHex = bytesToHex(new Uint8Array(16).fill(5));
    const regBody = await buildRegisterVerifyBody(5, prfSaltHex, "cred-full");
    const regRes = await registerVerify({ request: postJson("http://x/v", regBody, regChal), env });
    const { accountId } = (await regRes.json()) as { accountId: string };

    const loRes = await loginOptions({ request: postJson("http://x/lo", { email: "full@example.com" }), env });
    const loChal = cookieValue(loRes.headers.get("set-cookie"));

    const authenticationResponse = {
      id: "cred-full",
      rawId: "cred-full",
      response: { clientDataJSON: "e30", authenticatorData: "e30", signature: "e30" },
      clientExtensionResults: {},
      type: "public-key",
    };
    const res = await loginVerify({ request: postJson("http://x/lv", { authenticationResponse }, loChal), env });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/hd_session=/);

    const data = (await res.json()) as { wrappedPrivateKey: string; prfSalt: string; ownerEnvelope: unknown };
    expect(data.wrappedPrivateKey).toBeTruthy();
    expect(data.prfSalt).toBe(prfSaltHex);
    expect(data.ownerEnvelope).toBeTruthy();

    const cred = await getCredential(db, accountId, "passkey");
    expect((cred!.kdfParams as { counter: number }).counter).toBe(1);
  });

  it("verify 401s for an unrecognized credential id", async () => {
    const env = makeEnv(new Map());
    const regChal = cookieValue(
      (await registerOptions({ request: postJson("http://x/o", { email: "unk@example.com", displayName: "Unk" }), env })).headers.get(
        "set-cookie"
      )
    );
    await registerVerify({
      request: postJson("http://x/v", await buildRegisterVerifyBody(6, bytesToHex(new Uint8Array(16).fill(6)), "cred-unk"), regChal),
      env,
    });

    const loChal = cookieValue(
      (await loginOptions({ request: postJson("http://x/lo", { email: "unk@example.com" }), env })).headers.get("set-cookie")
    );

    const res = await loginVerify({
      request: postJson(
        "http://x/lv",
        { authenticationResponse: { id: "someone-elses-cred", rawId: "x", response: {}, clientExtensionResults: {}, type: "public-key" } },
        loChal
      ),
      env,
    });
    expect(res.status).toBe(401);
  });

  it("verify 400s with a missing challenge cookie", async () => {
    const env = makeEnv(new Map());
    const res = await loginVerify({
      request: postJson("http://x/lv", { authenticationResponse: { id: "cred-1", rawId: "x", response: {}, clientExtensionResults: {}, type: "public-key" } }),
      env,
    });
    expect(res.status).toBe(400);
  });
});

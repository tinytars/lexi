import { applyMigrations } from "./_migrate";
import { onRequestGet as pwSalt } from "../../functions/api/auth/password/salt";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestPost as signup } from "../../functions/api/auth/password/signup";
import { onRequestPost as login } from "../../functions/api/auth/password/login";
import { createAccount, getAccountByEmail } from "../../functions/_lib/identity-accounts";
import { getCredential } from "../../functions/_lib/identity-credentials";
import { getEnvelope, listEnvelopesForVault, listVaultsForOwner } from "../../functions/_lib/identity-vault";
import { ORG_ACCOUNT_ID } from "../../functions/_lib/org";
import {
  generateAccountKeypair,
  deriveKekFromPassword,
  deriveAuthHash,
  wrapPrivateKey,
  generateDEK,
  encryptVaultV2,
  wrapDEKForPublicKey,
} from "@tinytars/vault/crypto";

let mf: Miniflare;
let db: any; // D1Database
let orgPublicKeyJwk: JsonWebKey;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-auth" },
  });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
  // W55 P4 — signup now writes a second envelope to ORG_ACCOUNT_ID; the FK on
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
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

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
  };
}

// Builds a real signup request body by driving the actual browser-side crypto
// primitives (src/lib/crypto.ts) — the Function must accept exactly what
// src/lib/auth-client.ts produces.
async function buildSignupBody(email: string, displayName: string, password: string) {
  const { publicKeyJwk, privateKey } = await generateAccountKeypair();
  const salt = rand(16);
  const kek = await deriveKekFromPassword(password, salt);
  const wrappedPrivateKey = await wrapPrivateKey(privateKey, kek);
  const authHash = await deriveAuthHash(password, salt);
  const dek = await generateDEK();
  const vaultBlob = await encryptVaultV2({ clients: {} }, dek);
  const ownerEnvelope = await wrapDEKForPublicKey(dek, publicKeyJwk);
  const orgEnvelope = await wrapDEKForPublicKey(dek, orgPublicKeyJwk);

  return {
    authHash,
    body: {
      email,
      displayName,
      publicKeyJwk,
      wrappedPrivateKey: bytesToBase64(wrappedPrivateKey),
      kdfParams: { salt: bytesToHex(salt), iterations: 200_000 },
      authHash,
      vaultBlob: bytesToBase64(vaultBlob),
      ownerEnvelope: {
        wrappedDEK: bytesToBase64(ownerEnvelope.wrappedDEK),
        ephemeralPublicKeyJwk: ownerEnvelope.ephemeralPublicKeyJwk,
      },
      orgEnvelope: {
        wrappedDEK: bytesToBase64(orgEnvelope.wrappedDEK),
        ephemeralPublicKeyJwk: orgEnvelope.ephemeralPublicKeyJwk,
      },
    },
  };
}

function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/password/signup", () => {
  it("200s, persists account/vault/envelope rows, stores the R2 blob, sets a session cookie", async () => {
    const store = new Map<string, Uint8Array>();
    const env = makeEnv(store);
    const { body } = await buildSignupBody("pablo@example.com", "Pablo", "hunter2");

    const res = await signup({ request: postJson("http://x/api/auth/password/signup", body), env });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^hd_session=/);

    const { accountId, vaultId } = (await res.json()) as { accountId: string; vaultId: string };

    const account = await getAccountByEmail(db, "pablo@example.com");
    expect(account?.id).toBe(accountId);

    const vaults = await listVaultsForOwner(db, accountId);
    expect(vaults.map((v) => v.vaultId)).toEqual([vaultId]);

    const envelope = await getEnvelope(db, vaultId, accountId);
    expect(envelope).not.toBeNull();

    // W55 P4 — signup mints exactly two envelopes: the owner's and the org-recovery one.
    const envelopes = await listEnvelopesForVault(db, vaultId);
    expect(envelopes.map((e) => e.principalAccountId).sort()).toEqual([accountId, ORG_ACCOUNT_ID].sort());

    expect(store.has(`test/${vaults[0].r2Key}`)).toBe(true);

    const cred = await getCredential(db, accountId, "password");
    expect(cred).not.toBeNull();
    expect((cred!.kdfParams as { authHashSha256: string }).authHashSha256).toBeTruthy();
  });

  it("400s when orgEnvelope is missing", async () => {
    const env = makeEnv(new Map());
    const { body } = await buildSignupBody("noorg@example.com", "NoOrg", "hunter2");
    delete (body as { orgEnvelope?: unknown }).orgEnvelope;

    const res = await signup({ request: postJson("http://x/s", body), env });
    expect(res.status).toBe(400);
  });

  it("409s on a duplicate email and does not touch R2", async () => {
    const store = new Map<string, Uint8Array>();
    const env = makeEnv(store);
    const { body } = await buildSignupBody("dup@example.com", "Dup", "hunter2");

    const first = await signup({ request: postJson("http://x/s", body), env });
    expect(first.status).toBe(200);
    const sizeAfterFirst = store.size;

    const second = await signup({ request: postJson("http://x/s", body), env });
    expect(second.status).toBe(409);
    expect(store.size).toBe(sizeAfterFirst);
  });
});

describe("POST /api/auth/password/login", () => {
  it("200s with the correct authHash, returns wrapped material, and rejects a wrong authHash", async () => {
    const store = new Map<string, Uint8Array>();
    const env = makeEnv(store);
    const { body, authHash } = await buildSignupBody("liz@example.com", "Liz", "correct-horse");
    await signup({ request: postJson("http://x/s", body), env });

    const ok = await login({ request: postJson("http://x/l", { email: "liz@example.com", authHash }), env });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/^hd_session=/);
    const data = (await ok.json()) as {
      wrappedPrivateKey: string;
      ownerEnvelope: unknown;
      kdfParams: Record<string, unknown>;
    };
    expect(data.wrappedPrivateKey).toBeTruthy();
    expect(data.ownerEnvelope).toBeTruthy();
    expect(data.kdfParams.authHashSha256).toBeUndefined();

    const bad = await login({ request: postJson("http://x/l", { email: "liz@example.com", authHash: "wrong-hash" }), env });
    expect(bad.status).toBe(401);
  });

  it("401s for an unknown email", async () => {
    const env = makeEnv(new Map());
    const res = await login({ request: postJson("http://x/l", { email: "nobody@example.com", authHash: "x" }), env });
    expect(res.status).toBe(401);
  });

  // W71 — login's uniform 401 was undone by the salt lookup that runs in front of it: 404 for an
  // unknown address, 200 for a registered one. Unauthenticated, unlogged, and on a health application
  // the question it answers is "is this person a patient here".
  describe("the salt lookup in front of login gives nothing away", () => {
    const saltFor = (env: ReturnType<typeof makeEnv>, email: string) =>
      pwSalt({ request: new Request(`http://x/api/auth/password/salt?email=${encodeURIComponent(email)}`), env });

    it("answers a registered address and an unknown one indistinguishably", async () => {
      const env = makeEnv(new Map());
      const real = await saltFor(env, "liz@example.com");
      const decoy = await saltFor(env, "nobody@example.com");
      expect(decoy.status).toBe(real.status);
      const a = (await real.json()) as { salt: string; iterations: number };
      const b = (await decoy.json()) as { salt: string; iterations: number };
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      expect(b.salt).toHaveLength(a.salt.length);
      expect(b.iterations).toBe(a.iterations);
      expect(b.salt).not.toBe(a.salt);
    });

    it("returns a stable decoy, so probing twice does not expose it", async () => {
      const env = makeEnv(new Map());
      const first = (await (await saltFor(env, "nobody@example.com")).json()) as { salt: string };
      const second = (await (await saltFor(env, "nobody@example.com")).json()) as { salt: string };
      expect(second.salt).toBe(first.salt);
    });

    // A constant decoy is an oracle again: recognise it once and every 200 carrying it is an unknown
    // address. This assertion is here because a mutation to a fixed string passed everything else.
    it("gives a different decoy per address, so a decoy is not recognisable as a constant", async () => {
      const env = makeEnv(new Map());
      const one = (await (await saltFor(env, "nobody-a@example.com")).json()) as { salt: string };
      const two = (await (await saltFor(env, "nobody-b@example.com")).json()) as { salt: string };
      expect(two.salt).not.toBe(one.salt);
    });

    it("still 400s with no email at all — that is a malformed request, not an answer", async () => {
      const env = makeEnv(new Map());
      expect((await pwSalt({ request: new Request("http://x/api/auth/password/salt"), env })).status).toBe(400);
    });
  });
});

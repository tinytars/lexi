// W73 Phase C — redeeming a recovery code now replaces the password, in the same request.
//
// Before this, redemption signed you in and left the forgotten password in place. The flow looked like
// it worked and was a trap: the next sign-in put the user straight back on the recovery screen, having
// spent their one written-down code to get nowhere. Whether the *code* verified was tested; whether the
// user ended up able to sign in again was not.
//
// It cannot be a follow-up call to /api/account/methods, and that is the load-bearing detail: the
// account still holds its old password credential, so W73's own step-up would demand the very password
// being recovered. So the code is re-proved on the installing request instead — the replacement is
// authorised by the code, never by the session the first call minted.

import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestPost as regen } from "../../functions/api/account/recovery";
import { onRequestPost as recLogin } from "../../functions/api/auth/recovery/login";
import { onRequestPost as pwLogin } from "../../functions/api/auth/password/login";
import type { D1Database } from "../../functions/_lib/identity-types";
import { createAccount, sessionsValidFrom } from "../../functions/_lib/identity-accounts";
import { addIdentity, getCredential, putCredential } from "../../functions/_lib/identity-credentials";
import { signSession } from "../../functions/_lib/session";
import { sha256Base64Url } from "../../functions/_lib/verifier";
import {
  generateAccountKeypair, deriveKekFromPassword, wrapPrivateKey, deriveAuthHash, unwrapPrivateKey,
} from "@tinytars/vault/crypto";

const SECRET = "test-secret";
const ITER = 200_000;
let mf: Miniflare;
let db: any;

beforeEach(async () => {
  await mf?.dispose();
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: `test-rec-pw-${crypto.randomUUID()}` },
  });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as D1Database);
});
afterAll(async () => { await mf.dispose(); });

const env = () => ({ DB: db, SESSION_SECRET: SECRET }) as any;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

async function seed(email: string, password: string, code: string) {
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "A", email });
  const { privateKey } = await generateAccountKeypair();

  const pwSalt = rand(16);
  const pwAuth = await deriveAuthHash(password, pwSalt);
  await putCredential(db, {
    accountId: id, method: "password",
    wrappedPrivateKey: await wrapPrivateKey(privateKey, await deriveKekFromPassword(password, pwSalt)),
    kdfParams: { salt: hex(pwSalt), iterations: ITER, authHashSha256: await sha256Base64Url(pwAuth) },
  });
  await addIdentity(db, { accountId: id, method: "password" });

  const rSalt = rand(16);
  await regen({
    request: new Request("http://x/api/account/recovery", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}` },
      body: JSON.stringify({
        wrappedPrivateKey: b64(await wrapPrivateKey(privateKey, await deriveKekFromPassword(code, rSalt))),
        kdfParams: { salt: hex(rSalt), iterations: ITER },
        recoveryAuthHash: await deriveAuthHash(code, rSalt),
      }),
    }),
    env: env(),
  } as any);
  return { id, privateKey, rSalt };
}

const redeem = (body: unknown) =>
  recLogin({
    request: new Request("http://x/api/auth/recovery/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    env: env(),
  } as any);

const signIn = (email: string, authHash: string) =>
  pwLogin({
    request: new Request("http://x/api/auth/password/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, authHash }),
    }),
    env: env(),
  } as any);

async function newCredentialFor(privateKey: CryptoKey, password: string) {
  const salt = rand(16);
  return {
    salt,
    body: {
      wrappedPrivateKey: b64(await wrapPrivateKey(privateKey, await deriveKekFromPassword(password, salt))),
      kdfParams: { salt: hex(salt), iterations: ITER },
      authHash: await deriveAuthHash(password, salt),
    },
  };
}

describe("redeeming a code replaces the password", () => {
  it("leaves the user able to sign in normally afterwards", async () => {
    // The whole point. A test that only asserted a 200 from redemption would have passed for the
    // entire time this flow was a dead end.
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    const rAuth = await deriveAuthHash("CODE-1", a.rSalt);

    expect((await redeem({ email: "a@example.com", recoveryAuthHash: rAuth, newCredential: nc.body })).status).toBe(200);

    const login = await signIn("a@example.com", await deriveAuthHash("brand-new", nc.salt));
    expect(login.status).toBe(200);
  });

  it("re-wraps the SAME account key, so the record still opens", async () => {
    // Not a new keypair. If it were, every envelope wrapping the DEK to the old public key would be
    // orphaned and the user would sign in to a record they could no longer decrypt.
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });

    const cred = await getCredential(db, a.id, "password");
    const recovered = await unwrapPrivateKey(cred!.wrappedPrivateKey, await deriveKekFromPassword("brand-new", nc.salt));
    const before = await crypto.subtle.exportKey("pkcs8", a.privateKey);
    const after = await crypto.subtle.exportKey("pkcs8", recovered);
    expect(Buffer.from(after).toString("base64")).toBe(Buffer.from(before).toString("base64"));
  });

  it("kills the old password", async () => {
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const oldCred = await getCredential(db, a.id, "password");
    const oldSalt = hexToBytes((oldCred!.kdfParams as any).salt);
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });

    expect((await signIn("a@example.com", await deriveAuthHash("forgotten", oldSalt))).status).toBe(401);
  });

  it("revokes sessions issued under the old password (RECOVERY.md I5)", async () => {
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    expect(await sessionsValidFrom(db, a.id)).toBeNull();
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });
    expect(await sessionsValidFrom(db, a.id)).toBeTruthy();
  });

  it("still issues a cookie that survives the revocation it just performed", async () => {
    // revokeSessions runs BEFORE the token is minted. Getting that order wrong signs out the one person
    // who just proved they own the account.
    //
    // Checked with requireSession, NOT verifySession: verifySession is the pure HMAC check and passes
    // for a token that revocation has already invalidated, so a test written against it would go green
    // for either ordering. That is exactly what happened to the first draft of this test.
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    const res = await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/hd_session=/);

    const { requireSession } = await import("../../functions/_lib/session");
    const asRequest = new Request("http://x/api/account", { headers: { cookie } });
    expect(await requireSession(asRequest, env())).toEqual({ accountId: a.id });
  });

  it("does NOT keep a cookie minted before the recovery", async () => {
    // The other half of I5, and the reason the ordering matters at all: a cookie someone else was
    // holding must stop working.
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const stale = `hd_session=${await signSession({ SESSION_SECRET: SECRET }, a.id)}`;
    await new Promise((r) => setTimeout(r, 1100)); // session iat has 1s resolution
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });

    const { requireSession } = await import("../../functions/_lib/session");
    const res = await requireSession(new Request("http://x/api/account", { headers: { cookie: stale } }), env());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it("leaves the passkey and Google credentials alone — they wrap the same key", async () => {
    // The distinction from a provider-issued recovery (Phase D), which mints a NEW keypair and must
    // therefore clear them. Deleting them here would lock a passkey user out of their own authenticator
    // for no reason.
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    await putCredential(db, { accountId: a.id, method: "passkey", wrappedPrivateKey: rand(48), kdfParams: { credentialID: "c1" } });
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });
    expect(await getCredential(db, a.id, "passkey")).not.toBeNull();
  });
});

describe("the replacement is authorised by the code, not by a session", () => {
  it("refuses to install a password when the recovery code is wrong", async () => {
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const nc = await newCredentialFor(a.privateKey, "attacker-chosen");
    const res = await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("WRONG", a.rSalt), newCredential: nc.body });
    expect(res.status).toBe(401);

    // …and nothing was written. A route that verified after writing would hand the account away.
    const oldCred = await getCredential(db, a.id, "password");
    const oldSalt = hexToBytes((oldCred!.kdfParams as any).salt);
    expect((await signIn("a@example.com", await deriveAuthHash("forgotten", oldSalt))).status).toBe(200);
  });

  it("rejects a malformed newCredential rather than half-installing it", async () => {
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const rAuth = await deriveAuthHash("CODE-1", a.rSalt);
    const res = await redeem({ email: "a@example.com", recoveryAuthHash: rAuth, newCredential: { wrappedPrivateKey: "x" } });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/wrappedPrivateKey, kdfParams and authHash/);
  });

  it("still supports redemption with no new password, so the first call can fetch the key", async () => {
    // The client redeems twice: once to obtain the wrapped key (the only way to get it), once to
    // install the re-wrapped one. The first call must keep working exactly as before.
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const res = await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt) });
    expect(res.status).toBe(200);
    expect((await res.json() as any).wrappedPrivateKey).toBeTruthy();
    expect(await sessionsValidFrom(db, a.id)).toBeNull(); // nothing replaced, nothing revoked
  });
});

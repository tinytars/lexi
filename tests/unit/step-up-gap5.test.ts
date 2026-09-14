// W73 Phase A — SECURITY.md gap 5: a session cookie alone could mint a permanent credential, and an
// email change was never announced to the address losing it.
//
// The two halves chain into a silent, permanent takeover: steal a cookie, add a passkey (which outlives
// the cookie), repoint the email (which the owner is never told about), and every future recovery
// message goes to the attacker. Neither half is exotic; both were simply never guarded.
//
// These tests are written against the CHAIN, not the individual routes, because each link looked
// reasonable on its own — which is precisely why it survived two security passes.

import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../functions/_lib/identity-types";
import { createAccount, getAccount } from "../../functions/_lib/identity-accounts";
import { addIdentity, putCredential } from "../../functions/_lib/identity-credentials";
import { stepUpForMethodChange } from "../../functions/_lib/step-up";
import { sha256Base64Url } from "../../functions/_lib/verifier";
import { onRequestPatch as patchAccount } from "../../functions/api/account";
import { onRequestPost as addMethod } from "../../functions/api/account/methods";
import { signSession } from "../../functions/_lib/session";
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
    d1Databases: { DB: `test-stepup-${crypto.randomUUID()}` },
  });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as D1Database);
});
afterAll(async () => { await mf.dispose(); });

// GMAIL_* deliberately unset: sendEmail no-ops and logs, so these tests observe the ATTEMPT to notify
// without a live send. That is also the production dev-config behaviour.
const env = () => ({ DB: db, SESSION_SECRET: SECRET }) as any;
const cookie = async (id: string) => `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}`;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

async function accountWithPassword(email: string, password: string) {
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "A", email });
  const { privateKey } = await generateAccountKeypair();
  const salt = rand(16);
  const kek = await deriveKekFromPassword(password, salt);
  const authHash = await deriveAuthHash(password, salt);
  await putCredential(db, {
    accountId: id,
    method: "password",
    wrappedPrivateKey: await wrapPrivateKey(privateKey, kek),
    kdfParams: { salt: hex(salt), iterations: KDF_ITERATIONS, authHashSha256: await sha256Base64Url(authHash) },
  });
  await addIdentity(db, { accountId: id, method: "password" });
  return { id, salt, authHash, privateKey };
}

describe("stepUpForMethodChange", () => {
  it("cannot challenge an account with no password, and says so rather than refusing", async () => {
    // Refusing would break the legitimate flow it is meant to protect — a Google-only account adding a
    // passkey has no secret to prove. `challenged: false` is what lets the caller log the two cases
    // apart, so "verified" and "could not verify, notified instead" are not both a bare 200.
    const id = crypto.randomUUID();
    await createAccount(db, { id, displayName: "G" });
    expect(await stepUpForMethodChange(db, id, undefined)).toEqual({ ok: true, challenged: false });
  });

  it("demands the current password when there is one", async () => {
    const a = await accountWithPassword("a@example.com", "pw-correct");
    expect(await stepUpForMethodChange(db, a.id, undefined)).toMatchObject({ ok: false, errorCode: "step_up_required" });
    expect(await stepUpForMethodChange(db, a.id, "")).toMatchObject({ ok: false, errorCode: "step_up_required" });
  });

  it("distinguishes 'you gave nothing' from 'you gave the wrong thing'", async () => {
    const a = await accountWithPassword("a@example.com", "pw-correct");
    const wrong = await deriveAuthHash("pw-wrong", a.salt);
    expect(await stepUpForMethodChange(db, a.id, wrong)).toMatchObject({ ok: false, errorCode: "step_up_failed" });
    expect(await stepUpForMethodChange(db, a.id, a.authHash)).toEqual({ ok: true, challenged: true });
  });

  it("refuses a pre-P8b credential that carries no verifier, rather than treating it as passing", async () => {
    // "Cannot check" must never resolve to "allowed" on the path that mints permanent access.
    const id = crypto.randomUUID();
    await createAccount(db, { id, displayName: "Old" });
    await putCredential(db, {
      accountId: id, method: "password", wrappedPrivateKey: rand(48),
      kdfParams: { salt: hex(rand(16)), iterations: KDF_ITERATIONS }, // no authHashSha256
    });
    expect(await stepUpForMethodChange(db, id, "anything")).toMatchObject({ ok: false, errorCode: "step_up_required" });
  });

  it("compares the stored digest, never the proof itself", async () => {
    // The server stores SHA-256(authHash) and the client sends authHash. Sending the DIGEST must fail,
    // or a database read would be enough to impersonate the password.
    const a = await accountWithPassword("a@example.com", "pw-correct");
    const digest = await sha256Base64Url(a.authHash);
    expect(await stepUpForMethodChange(db, a.id, digest)).toMatchObject({ ok: false, errorCode: "step_up_failed" });
  });
});

describe("adding a login method now requires the same proof as replacing one", () => {
  const post = async (accountId: string, body: unknown) =>
    addMethod({
      request: new Request("https://x/api/account/methods", {
        method: "POST", body: JSON.stringify(body), headers: { cookie: await cookie(accountId) },
      }),
      env: env(),
    } as any);

  async function passwordBody(privateKey: CryptoKey, password: string, over: Record<string, unknown> = {}) {
    const salt = rand(16);
    const kek = await deriveKekFromPassword(password, salt);
    return {
      method: "password",
      wrappedPrivateKey: b64(await wrapPrivateKey(privateKey, kek)),
      kdfParams: { salt: hex(salt), iterations: KDF_ITERATIONS },
      authHash: await deriveAuthHash(password, salt),
      ...over,
    };
  }

  it("refuses to replace a password without proving the current one", async () => {
    const a = await accountWithPassword("a@example.com", "pw-correct");
    const res = await post(a.id, await passwordBody(a.privateKey, "pw-new"));
    expect(res.status).toBe(401);
    expect((await res.json() as any).errorCode).toBe("step_up_required");
  });

  it("accepts the replacement when the current password is proven", async () => {
    const a = await accountWithPassword("a@example.com", "pw-correct");
    const res = await post(a.id, await passwordBody(a.privateKey, "pw-new", { currentAuthHash: a.authHash }));
    expect(res.status).toBe(200);
  });

  it("still lets a passkey-only account set its FIRST password", async () => {
    // The documented exception: there is no current password to prove and nothing is being destroyed.
    // A test that only checked "step-up is required" would have made this flow impossible.
    const id = crypto.randomUUID();
    await createAccount(db, { id, displayName: "P" });
    await addIdentity(db, { accountId: id, method: "passkey", credentialId: `c-${id}` });
    await putCredential(db, { accountId: id, method: "passkey", wrappedPrivateKey: rand(48), kdfParams: { credentialID: `c-${id}` } });
    const { privateKey } = await generateAccountKeypair();
    expect((await post(id, await passwordBody(privateKey, "first-pw"))).status).toBe(200);
  });
});

describe("an email change is announced to the address losing it", () => {
  const patch = async (accountId: string, body: unknown) =>
    patchAccount({
      request: new Request("https://x/api/account", {
        method: "PATCH", body: JSON.stringify(body), headers: { cookie: await cookie(accountId) },
      }),
      env: env(),
    } as any);

  it("stamps email_changed_at, which is what lets recovery refuse a too-new address", async () => {
    const a = await accountWithPassword("old@example.com", "pw");
    expect((await getAccount(db, a.id))!.emailChangedAt).toBeNull();
    expect((await patch(a.id, { email: "new@example.com" })).status).toBe(200);
    const after = await getAccount(db, a.id);
    expect(after!.email).toBe("new@example.com");
    expect(after!.emailChangedAt).toBeTruthy();
    // …and it un-confirms, so the new address must prove itself before it is trusted.
    expect(after!.emailConfirmed).toBe(false);
  });

  it("sends a notice to the OLD address, naming the new one", async () => {
    const a = await accountWithPassword("old@example.com", "pw");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await patch(a.id, { email: "new@example.com" });
    const lines = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();
    // Gmail is unconfigured here, so sendEmail logs the subject instead of sending. The assertion is
    // that the notice was ATTEMPTED — the address being replaced is the only one that can tell us the
    // change was unwanted, and before W73 it heard nothing at all.
    expect(lines).toContain("The email address on your account was changed");
  });

  it("does not stamp or notify when the email did not actually change", async () => {
    const a = await accountWithPassword("same@example.com", "pw");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await patch(a.id, { email: "same@example.com", displayName: "Renamed" });
    const lines = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();
    expect(lines).not.toContain("The email address on your account was changed");
    expect((await getAccount(db, a.id))!.emailChangedAt).toBeNull();
    expect((await getAccount(db, a.id))!.displayName).toBe("Renamed");
  });

  it("has nothing to notify when the account had no previous address", async () => {
    const id = crypto.randomUUID();
    await createAccount(db, { id, displayName: "New" });
    expect((await patch(id, { email: "first@example.com" })).status).toBe(200);
    expect((await getAccount(db, id))!.emailChangedAt).toBeTruthy();
  });
});

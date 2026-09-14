import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestGet as listM, onRequestPost as addM, onRequestDelete as delM } from "../../functions/api/account/methods";
import { onRequestPost as pwLogin } from "../../functions/api/auth/password/login";
import { onRequestGet as pwSalt } from "../../functions/api/auth/password/salt";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { addIdentity, getCredential, putCredential } from "../../functions/_lib/identity-credentials";
import { signSession } from "../../functions/_lib/session";
import { generateAccountKeypair, deriveKekFromPassword, wrapPrivateKey, deriveAuthHash } from "@tinytars/vault/crypto";

let mf: Miniflare;
let db: any;
const SECRET = "test-secret";
const KDF_ITERATIONS = 200_000;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-account-methods" } });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
});
afterAll(async () => { await mf.dispose(); });

const makeEnv = () => ({ DB: db, SESSION_SECRET: SECRET }) as any;
const cookieFor = async (id: string) => `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}`;
const bytesToBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

async function mkAccount(email: string) {
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "A", email });
  return id;
}
async function seedPasskey(accountId: string) {
  await addIdentity(db, { accountId, method: "passkey", credentialId: `cred-${accountId}` });
  await putCredential(db, { accountId, method: "passkey", wrappedPrivateKey: rand(48), kdfParams: { credentialID: `cred-${accountId}` } });
}
async function addPasswordBody(privateKey: CryptoKey, password: string) {
  const salt = rand(16);
  const kek = await deriveKekFromPassword(password, salt);
  const wrappedPrivateKey = await wrapPrivateKey(privateKey, kek);
  const authHash = await deriveAuthHash(password, salt);
  return { method: "password", wrappedPrivateKey: bytesToBase64(wrappedPrivateKey), kdfParams: { salt: bytesToHex(salt), iterations: KDF_ITERATIONS }, authHash };
}
const postJson = (fn: any, cookie: string | null, body: unknown) =>
  fn({ request: new Request("http://x/api/account/methods", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }), env: makeEnv() });

describe("account methods", () => {
  it("401s without a session", async () => {
    const res = await listM({ request: new Request("http://x/api/account/methods"), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it("adds a password method that then logs in (round-trip)", async () => {
    const email = `u-${crypto.randomUUID()}@x.test`;
    const id = await mkAccount(email);
    await seedPasskey(id); // passkey-only account gains a password
    const { privateKey } = await generateAccountKeypair();

    const add = await postJson(addM, await cookieFor(id), await addPasswordBody(privateKey, "hunter2pw"));
    expect(add.status).toBe(200);

    // GET lists both methods
    const methods = (await (await listM({ request: new Request("http://x/api/account/methods", { headers: { cookie: await cookieFor(id) } }), env: makeEnv() })).json() as { methods: { method: string }[] }).methods;
    expect(methods.map((m) => m.method).sort()).toEqual(["passkey", "password"]);

    // the new password logs in: fetch salt, derive authHash, POST login → 200
    const saltRes = await pwSalt({ request: new Request(`http://x/api/auth/password/salt?email=${encodeURIComponent(email)}`), env: makeEnv() });
    const { salt } = await saltRes.json() as { salt: string };
    const authHash = await deriveAuthHash("hunter2pw", hexToBytes(salt));
    const login = await pwLogin({ request: new Request("http://x/api/auth/password/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, authHash }) }), env: makeEnv() });
    expect(login.status).toBe(200);
  });

  // W71 — replacing the password used to need only a session cookie, so a stolen cookie was a silent,
  // permanent account takeover: set a new password and the real owner is locked out of their own
  // health record with nothing to notice. Session revocation shortens how long a stolen cookie stays
  // useful; it does not stop that cookie seizing the account inside the window.
  describe("replacing a password requires proving you know the current one", () => {
    /** An account that already has a password, plus a helper to prove it. */
    async function withPassword(password: string) {
      const email = `u-${crypto.randomUUID()}@x.test`;
      const id = await mkAccount(email);
      await seedPasskey(id);
      const { privateKey } = await generateAccountKeypair();
      expect((await postJson(addM, await cookieFor(id), await addPasswordBody(privateKey, password))).status).toBe(200);
      return { id, email, privateKey };
    }
    const proofFor = async (email: string, password: string) => {
      const { salt } = (await (await pwSalt({
        request: new Request(`http://x/api/auth/password/salt?email=${encodeURIComponent(email)}`),
        env: makeEnv(),
      })).json()) as { salt: string };
      return deriveAuthHash(password, hexToBytes(salt));
    };

    it("refuses a replacement with no proof at all", async () => {
      const a = await withPassword("original-pw");
      const res = await postJson(addM, await cookieFor(a.id), await addPasswordBody(a.privateKey, "attacker-pw"));
      expect(res.status).toBe(401);
      expect((await res.json()).errorCode).toBe("step_up_required");
    });

    it("refuses a replacement with the WRONG current password", async () => {
      const a = await withPassword("original-pw");
      const body = { ...(await addPasswordBody(a.privateKey, "attacker-pw")), currentAuthHash: await proofFor(a.email, "guessing") };
      expect((await postJson(addM, await cookieFor(a.id), body)).status).toBe(401);
    });

    it("and the original password still works after a refused attempt", async () => {
      // The attempt must not have partially applied — the owner is not locked out by a failed attack.
      const a = await withPassword("original-pw");
      await postJson(addM, await cookieFor(a.id), await addPasswordBody(a.privateKey, "attacker-pw"));
      const login = await pwLogin({
        request: new Request("http://x/api/auth/password/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: a.email, authHash: await proofFor(a.email, "original-pw") }),
        }),
        env: makeEnv(),
      });
      expect(login.status).toBe(200);
    });

    it("accepts a replacement proved with the current password, and the NEW one then logs in", async () => {
      const a = await withPassword("original-pw");
      const body = { ...(await addPasswordBody(a.privateKey, "replacement-pw")), currentAuthHash: await proofFor(a.email, "original-pw") };
      expect((await postJson(addM, await cookieFor(a.id), body)).status).toBe(200);

      const login = await pwLogin({
        request: new Request("http://x/api/auth/password/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: a.email, authHash: await proofFor(a.email, "replacement-pw") }),
        }),
        env: makeEnv(),
      });
      expect(login.status).toBe(200);
    });

    it("a first password needs no proof — there is nothing to prove and nothing destroyed", async () => {
      // A passkey-only or Google-only account must still be able to add one; demanding a current
      // password there would make the flow impossible rather than safe.
      const id = await mkAccount(`u-${crypto.randomUUID()}@x.test`);
      await seedPasskey(id);
      const { privateKey } = await generateAccountKeypair();
      expect((await postJson(addM, await cookieFor(id), await addPasswordBody(privateKey, "first-pw"))).status).toBe(200);
    });
  });

  it("removes a method when another login method remains", async () => {
    const id = await mkAccount(`u-${crypto.randomUUID()}@x.test`);
    await seedPasskey(id);
    const { privateKey } = await generateAccountKeypair();
    await postJson(addM, await cookieFor(id), await addPasswordBody(privateKey, "pw"));

    const res = await delM({ request: new Request("http://x/api/account/methods", { method: "DELETE", headers: { "content-type": "application/json", cookie: await cookieFor(id) }, body: JSON.stringify({ method: "password" }) }), env: makeEnv() });
    expect(res.status).toBe(200);
    expect(await getCredential(db, id, "password")).toBeNull();
    expect(await getCredential(db, id, "passkey")).not.toBeNull();
  });

  it("refuses to remove the only login method (409, no lockout)", async () => {
    const id = await mkAccount(`u-${crypto.randomUUID()}@x.test`);
    await seedPasskey(id);
    const res = await delM({ request: new Request("http://x/api/account/methods", { method: "DELETE", headers: { "content-type": "application/json", cookie: await cookieFor(id) }, body: JSON.stringify({ method: "passkey" }) }), env: makeEnv() });
    expect(res.status).toBe(409);
    expect(await getCredential(db, id, "passkey")).not.toBeNull();
  });
});

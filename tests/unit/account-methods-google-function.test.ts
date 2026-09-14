import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestPost as linkGoogleFinish } from "../../functions/api/account/methods/google";
import { createAccount, getAccount, setEmailConfirmed } from "../../functions/_lib/identity-accounts";
import { signSession, signValue } from "../../functions/_lib/session";
import { generateAccountKeypair } from "@tinytars/vault/crypto";

// W50 — linking Google to an existing account adopts the Google-verified email as the account email
// (over an empty/unverified one) and marks it confirmed, but leaves an already-verified email untouched.

let mf: Miniflare;
let db: any;
const SECRET = "test-secret";
const GOOGLE_KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-link-google" } });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
});
afterAll(async () => { await mf.dispose(); });

async function exportPkcs8(privateKey: CryptoKey): Promise<string> {
  return Buffer.from(new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey))).toString("base64");
}
async function seedAccount(email: string | null, confirmed: boolean) {
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "P", email });
  if (confirmed) await setEmailConfirmed(db, id, true);
  return id;
}
async function callLink(accountId: string, link: { email: string | null; emailVerified: boolean }, pkcs8: string) {
  const cookie = `hd_session=${await signSession({ SESSION_SECRET: SECRET }, accountId)}; hd_google_link=${await signValue(SECRET, { accountId, sub: "sub-" + crypto.randomUUID(), ...link }, 600)}`;
  return linkGoogleFinish({
    request: new Request("http://x", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ privateKeyPkcs8: pkcs8 }) }),
    env: { DB: db, SESSION_SECRET: SECRET, GOOGLE_KEK } as any,
  });
}

// Unique per test — accounts.email is UNIQUE and the suite shares one D1.
const uniq = (label: string) => `${label}-${crypto.randomUUID()}`;

describe("linking Google adopts + confirms the verified email", () => {
  it("adopts the Google email and confirms it over an unverified placeholder", async () => {
    const kp = await generateAccountKeypair();
    const google = `${uniq("real")}@gmail.com`;
    const id = await seedAccount(`${uniq("placeholder")}@local.invalid`, false);
    const res = await callLink(id, { email: google, emailVerified: true }, await exportPkcs8(kp.privateKey));
    expect(res.status).toBe(200);
    const acct = await getAccount(db, id);
    expect(acct?.email).toBe(google);
    expect(acct?.emailConfirmed).toBe(true);
  });

  it("fills + confirms when the account had no email", async () => {
    const kp = await generateAccountKeypair();
    const google = `${uniq("real")}@gmail.com`;
    const id = await seedAccount(null, false);
    const res = await callLink(id, { email: google, emailVerified: true }, await exportPkcs8(kp.privateKey));
    expect(res.status).toBe(200);
    const acct = await getAccount(db, id);
    expect(acct?.email).toBe(google);
    expect(acct?.emailConfirmed).toBe(true);
  });

  it("leaves an already-verified email untouched", async () => {
    const kp = await generateAccountKeypair();
    const chosen = `${uniq("chosen")}@example.com`;
    const id = await seedAccount(chosen, true);
    const res = await callLink(id, { email: `${uniq("other")}@gmail.com`, emailVerified: true }, await exportPkcs8(kp.privateKey));
    expect(res.status).toBe(200);
    const acct = await getAccount(db, id);
    expect(acct?.email).toBe(chosen);
    expect(acct?.emailConfirmed).toBe(true);
  });

  it("does not adopt (or crash) when another account already owns the Google email", async () => {
    // Repro of the soul@… → support link: the Google email still belongs to another account, and
    // accounts.email is UNIQUE — adoption must be skipped, not throw a UNIQUE-constraint error.
    const kp = await generateAccountKeypair();
    const taken = `${uniq("taken")}@gmail.com`;
    await seedAccount(taken, true); // another account already owns this email
    const supportEmail = `${uniq("support")}@local.invalid`;
    const id = await seedAccount(supportEmail, false);
    const res = await callLink(id, { email: taken, emailVerified: true }, await exportPkcs8(kp.privateKey));
    expect(res.status).toBe(200); // link still succeeds
    const acct = await getAccount(db, id);
    expect(acct?.email).toBe(supportEmail); // email unchanged (not adopted)
    expect(acct?.emailConfirmed).toBe(false);
  });

  it("does not confirm when Google reports the email unverified", async () => {
    const kp = await generateAccountKeypair();
    const placeholder = `${uniq("placeholder")}@local.invalid`;
    const id = await seedAccount(placeholder, false);
    const res = await callLink(id, { email: `${uniq("real")}@gmail.com`, emailVerified: false }, await exportPkcs8(kp.privateKey));
    expect(res.status).toBe(200);
    const acct = await getAccount(db, id);
    expect(acct?.email).toBe(placeholder);
    expect(acct?.emailConfirmed).toBe(false);
  });
});

import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestGet as getAccountFn, onRequestPatch as patchAccountFn } from "../../functions/api/account";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { signSession } from "../../functions/_lib/session";

// M93 — account-level unit-system preference: GET/PATCH /api/account round-trips it, and it's
// independent per account (a provider's own setting never leaks into/out of a patient's).
let mf: Miniflare;
let db: any;
const SECRET = "test-secret";

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-account" } });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
});
afterAll(async () => { await mf.dispose(); });

const makeEnv = () => ({ DB: db, SESSION_SECRET: SECRET }) as any;
const cookieFor = async (id: string) => `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}`;

async function mkAccount(displayName: string) {
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName, email: `${id}@x.test` });
  return id;
}
const getAcct = (cookie: string) => getAccountFn({ request: new Request("http://x/api/account", { headers: { cookie } }), env: makeEnv() });
const patchAcct = (cookie: string, body: unknown) =>
  patchAccountFn({ request: new Request("http://x/api/account", { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), env: makeEnv() });

describe("account unit-system preference", () => {
  it("defaults to null (app layer falls back to imperial)", async () => {
    const id = await mkAccount("Fresh");
    const res = await getAcct(await cookieFor(id));
    expect((await res.json() as { unitSystem: unknown }).unitSystem).toBeNull();
  });

  it("round-trips a PATCH through GET", async () => {
    const id = await mkAccount("Patient");
    const cookie = await cookieFor(id);
    const patched = await patchAcct(cookie, { unitSystem: "metric" });
    expect(patched.status).toBe(200);
    expect((await patched.json() as { unitSystem: unknown }).unitSystem).toBe("metric");

    const got = await getAcct(cookie);
    expect((await got.json() as { unitSystem: unknown }).unitSystem).toBe("metric");
  });

  it("is independent per account — a provider's own setting doesn't affect a patient's", async () => {
    const patientId = await mkAccount("Patient B");
    const providerId = await mkAccount("Provider");
    const patientCookie = await cookieFor(patientId);
    const providerCookie = await cookieFor(providerId);

    await patchAcct(patientCookie, { unitSystem: "metric" });
    await patchAcct(providerCookie, { unitSystem: "imperial" });

    expect((await (await getAcct(patientCookie)).json() as { unitSystem: unknown }).unitSystem).toBe("metric");
    expect((await (await getAcct(providerCookie)).json() as { unitSystem: unknown }).unitSystem).toBe("imperial");
  });
});

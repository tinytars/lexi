import { describe, it, expect } from "vitest";
import { onRequestGet as getAccountFn, onRequestPatch as patchAccountFn } from "../../functions/api/account";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

// Unit-system preference round-trips through GET/PATCH /api/account, independently per account.
const w = useWorkerd();
const makeEnv = () => ({ DB: w.db, SESSION_SECRET }) as any;

async function mkAccount(displayName: string) {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName, email: `${id}@x.test` });
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

// 9C.3 — the server side of the age gate. The browser checks the birth year (src/lib/age-limit.ts)
// and the only thing that reaches us is that it passed.
describe("age attestation", () => {
  const attestedAt = (id: string) =>
    w.db.prepare("SELECT age_attested_at FROM accounts WHERE id = ?").bind(id).first<{ age_attested_at: string | null }>();

  it("is unset until the browser attests", async () => {
    const id = await mkAccount("Unattested");
    expect((await attestedAt(id))?.age_attested_at).toBeNull();
  });

  it("is stamped by a PATCH carrying ageAttested", async () => {
    const id = await mkAccount("Attesting");
    const res = await patchAcct(await cookieFor(id), { ageAttested: true });
    expect(res.status).toBe(200);
    expect((await attestedAt(id))?.age_attested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the first stamp — a later attestation does not move it", async () => {
    const id = await mkAccount("Reattesting");
    const cookie = await cookieFor(id);
    await patchAcct(cookie, { ageAttested: true });
    const first = (await attestedAt(id))?.age_attested_at;
    await new Promise((r) => setTimeout(r, 5));
    await patchAcct(cookie, { ageAttested: true });
    expect((await attestedAt(id))?.age_attested_at).toBe(first);
  });

  it("records no birth date — the column is the whole of what the server learns", async () => {
    const id = await mkAccount("No dob");
    await patchAcct(await cookieFor(id), { ageAttested: true });
    const row = await w.db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(Object.keys(row!).filter((k) => /dob|birth/i.test(k))).toEqual([]);
  });
});

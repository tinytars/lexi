import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { applyMigrations } from "./_migrate";
import { onRequestPost as logout } from "../../functions/api/auth/logout";
import { signSession, requireSession } from "../../functions/_lib/session";
import type { D1Database } from "../../functions/_lib/identity-types";
import { createAccount } from "../../functions/_lib/identity-accounts";

// W71 — logout used to be nothing but a Max-Age=0 on the cookie. The cookie is a self-contained
// 30-day HMAC, so a copy taken beforehand (a shared machine, a synced profile, a proxy log) kept
// working for the rest of its TTL: the browser had forgotten the session, the server never knew about
// it. That is the gap between "logged out" and logged out.

let mf: Miniflare;
let env: { SESSION_SECRET: string; DB: D1Database };

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-logout" } });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  env = { SESSION_SECRET: "test-secret", DB: db };
  await createAccount(db, { id: "acc-1", displayName: "A" });
  await createAccount(db, { id: "acc-2", displayName: "B" });
});
afterAll(async () => { await mf.dispose(); });

const post = (cookie?: string) =>
  logout({ request: new Request("http://x/api/auth/logout", { method: "POST", headers: cookie ? { cookie } : {} }), env });

describe("POST /api/auth/logout", () => {
  it("204s and expires the hd_session cookie", async () => {
    const res = await post();
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toMatch(/^hd_session=;/);
    expect(cookie).toMatch(/Max-Age=0/);
  });

  it("also invalidates the cookie server-side, so a copy of it stops working too", async () => {
    const token = await signSession(env, "acc-1");
    const carry = new Request("http://x/api/account", { headers: { cookie: `hd_session=${token}` } });
    expect(await requireSession(carry, env)).toEqual({ accountId: "acc-1" });

    await new Promise((r) => setTimeout(r, 1100)); // the revocation stamp has one-second resolution
    expect((await post(`hd_session=${token}`)).status).toBe(204);

    // The attacker's copy — same bytes, never sent through a browser that saw the Set-Cookie.
    expect(await requireSession(carry, env)).toBeInstanceOf(Response);
  });

  it("logs out only the account that asked", async () => {
    const other = await signSession(env, "acc-2");
    const req = new Request("http://x/api/account", { headers: { cookie: `hd_session=${other}` } });
    expect(await requireSession(req, env)).toEqual({ accountId: "acc-2" });
  });

  it("still 204s and clears the cookie when called without a session", async () => {
    const res = await post("hd_session=bogus");
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

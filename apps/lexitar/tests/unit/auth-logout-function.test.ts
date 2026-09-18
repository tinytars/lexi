import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { onRequestPost as logout } from "../../functions/api/auth/logout";
import { signSession, requireSession } from "../../functions/_lib/session";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET } from "../support/session";

// The cookie is a self-contained 30-day HMAC, so logout must revoke server-side or a copied cookie outlives it.
const w = useWorkerd();
const env = { SESSION_SECRET, get DB() { return w.db; } };

beforeAll(async () => {
  await createAccount(w.db, { id: "acc-1", displayName: "A" });
  await createAccount(w.db, { id: "acc-2", displayName: "B" });
});
afterEach(() => { vi.useRealTimers(); });

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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    const token = await signSession(env, "acc-1");
    const carry = new Request("http://x/api/account", { headers: { cookie: `hd_session=${token}` } });
    expect(await requireSession(carry, env)).toEqual({ accountId: "acc-1" });

    vi.setSystemTime(Date.now() + 1100); // the revocation stamp has one-second resolution
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

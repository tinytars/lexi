import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { signSession, verifySession, requireSession, sessionSetCookie } from "../../functions/_lib/session";
import { createAccount, revokeSessions } from "../../functions/_lib/identity-accounts";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET } from "../support/session";

// Real D1: a stub returning "not revoked" would agree with any requireSession, including a broken one.
const w = useWorkerd();
const env = { SESSION_SECRET, get DB() { return w.db; } };

beforeAll(async () => {
  for (const id of ["acc-1", "acc-2", "acc-3"]) await createAccount(w.db, { id, displayName: id });
});

describe("session", () => {
  it("round-trips a signed session to the same accountId", async () => {
    const token = await signSession(env, "acc-1");
    expect(await verifySession(env, token)).toMatchObject({ accountId: "acc-1" });
  });

  it("rejects a tampered payload", async () => {
    const token = await signSession(env, "acc-1");
    const [payload, sig] = token.split(".");
    const tampered = payload.slice(0, -1) + (payload.at(-1) === "A" ? "B" : "A");
    expect(await verifySession(env, `${tampered}.${sig}`)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const token = await signSession(env, "acc-1");
    const [payload, sig] = token.split(".");
    const tampered = sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
    expect(await verifySession(env, `${payload}.${tampered}`)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signSession(env, "acc-1", -1);
    expect(await verifySession(env, token)).toBeNull();
  });

  it("rejects malformed or missing tokens", async () => {
    expect(await verifySession(env, "not-a-token")).toBeNull();
    expect(await verifySession(env, null)).toBeNull();
    expect(await verifySession(env, undefined)).toBeNull();
  });

  describe("requireSession", () => {
    it("401s when there is no cookie", async () => {
      const request = new Request("http://x/api/account");
      const result = await requireSession(request, env);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it("returns the accountId when the cookie carries a valid session", async () => {
      const token = await signSession(env, "acc-1");
      const request = new Request("http://x/api/account", { headers: { cookie: `hd_session=${token}` } });
      expect(await requireSession(request, env)).toEqual({ accountId: "acc-1" });
    });

    it("401s on an expired session cookie", async () => {
      const token = await signSession(env, "acc-1", -1);
      const request = new Request("http://x/api/account", { headers: { cookie: `hd_session=${token}` } });
      const result = await requireSession(request, env);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it("finds hd_session among other cookies", async () => {
      const token = await signSession(env, "acc-2");
      const request = new Request("http://x/api/account", {
        headers: { cookie: `other=1; hd_session=${token}; another=2` },
      });
      expect(await requireSession(request, env)).toEqual({ accountId: "acc-2" });
    });
  });

  describe("a session can actually be revoked", () => {
    const withCookie = (token: string) => new Request("http://x/api/account", { headers: { cookie: `hd_session=${token}` } });
    // Only Date is faked — Miniflare needs real timers. The revocation stamp has one-second resolution.
    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
    afterEach(() => { vi.useRealTimers(); });

    it("a cookie issued before the revocation stops working, while its signature stays valid", async () => {
      const t = Date.now();
      const token = await signSession(env, "acc-3");
      expect(await requireSession(withCookie(token), env)).toEqual({ accountId: "acc-3" });

      vi.setSystemTime(t + 1000);
      await revokeSessions(env.DB, "acc-3");

      // Still authentic — this is the distinction the old code could not draw.
      expect(await verifySession(env, token)).toMatchObject({ accountId: "acc-3" });
      expect(await requireSession(withCookie(token), env)).toBeInstanceOf(Response);
    });

    it("does not touch any other account", async () => {
      const other = await signSession(env, "acc-1");
      expect(await requireSession(withCookie(other), env)).toEqual({ accountId: "acc-1" });
    });

    it("a cookie issued after the revocation works — logging back in is not blocked", async () => {
      const t = Date.now();
      await revokeSessions(env.DB, "acc-3");
      vi.setSystemTime(t + 1000);
      const fresh = await signSession(env, "acc-3");
      expect(await requireSession(withCookie(fresh), env)).toEqual({ accountId: "acc-3" });
    });

    it("a cookie for an account that no longer exists is refused", async () => {
      const token = await signSession(env, "acc-deleted");
      expect(await requireSession(withCookie(token), env)).toBeInstanceOf(Response);
    });
  });

  it("sessionSetCookie formats the Set-Cookie value", () => {
    expect(sessionSetCookie("tok", 100)).toBe("hd_session=tok; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=100");
  });
});

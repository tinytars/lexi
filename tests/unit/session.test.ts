import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signSession, verifySession, requireSession, sessionSetCookie } from "../../functions/_lib/session";
import type { D1Database } from "../../functions/_lib/identity-types";
import { createAccount, revokeSessions } from "../../functions/_lib/identity-accounts";

// Real D1, not a fake: since W71 requireSession consults accounts.sessions_valid_from, and the point
// of the column is that a revocation actually stops a cookie the signature still accepts. A stub that
// returns "not revoked" would agree with any implementation, including the one this replaced.
let mf: Miniflare;
let env: { SESSION_SECRET: string; DB: D1Database };

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-session" } });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const f of ["0001_identity.sql", "0007_session_revocation.sql"]) {
    const sql = readFileSync(fileURLToPath(new URL(`../../migrations/${f}`, import.meta.url)), "utf8");
    for (const stmt of sql.replace(/^\s*--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }
  env = { SESSION_SECRET: "test-secret", DB: db };
  for (const id of ["acc-1", "acc-2", "acc-3"]) await createAccount(db, { id, displayName: id });
});
afterAll(async () => { await mf.dispose(); });

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

  // W71 — the cookie is a self-contained 30-day HMAC with no jti and no server-side store, and logout
  // only cleared it. A captured cookie therefore survived logout, a password change and a passkey
  // removal alike; the only lever was rotating SESSION_SECRET, which signs out every account at once
  // and also invalidates email-verification tokens and WebAuthn challenges, since all five token
  // types share that one secret.
  describe("a session can actually be revoked", () => {
    const withCookie = (token: string) => new Request("http://x/api/account", { headers: { cookie: `hd_session=${token}` } });

    it("a cookie issued before the revocation stops working, while its signature stays valid", async () => {
      const token = await signSession(env, "acc-3");
      expect(await requireSession(withCookie(token), env)).toEqual({ accountId: "acc-3" });

      await new Promise((r) => setTimeout(r, 1100)); // the stamp has one-second resolution
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
      await new Promise((r) => setTimeout(r, 1100));
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

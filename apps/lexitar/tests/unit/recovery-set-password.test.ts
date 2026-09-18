// Recovery installs the new password on the same request, authorised by re-proving the code: a follow-up
// /api/account/methods call would demand step-up with the very password being recovered.
import { describe, it, expect, afterEach, vi } from "vitest";
import { onRequestPost as regen } from "../../functions/api/account/recovery";
import { onRequestPost as recLogin } from "../../functions/api/auth/recovery/login";
import { onRequestPost as pwLogin } from "../../functions/api/auth/password/login";
import { createAccount, sessionsValidFrom } from "../../functions/_lib/identity-accounts";
import { addIdentity, getCredential, putCredential } from "../../functions/_lib/identity-credentials";
import { sha256Base64Url } from "../../functions/_lib/verifier";
import {
  generateAccountKeypair, deriveKekFromPassword, wrapPrivateKey, deriveAuthHash, unwrapPrivateKey,
} from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const ITER = 200_000;
// Every test seeds the same fixed email, so each gets a fresh database.
const w = useWorkerd({ perTest: true });
afterEach(() => { vi.useRealTimers(); });

const env = () => ({ DB: w.db, SESSION_SECRET }) as any;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

async function seed(email: string, password: string, code: string) {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: "A", email });
  const { privateKey } = await generateAccountKeypair();

  const pwSalt = rand(16);
  const pwAuth = await deriveAuthHash(password, pwSalt);
  await putCredential(w.db, {
    accountId: id, method: "password",
    wrappedPrivateKey: await wrapPrivateKey(privateKey, await deriveKekFromPassword(password, pwSalt)),
    kdfParams: { salt: hex(pwSalt), iterations: ITER, authHashSha256: await sha256Base64Url(pwAuth) },
  });
  await addIdentity(w.db, { accountId: id, method: "password" });

  const rSalt = rand(16);
  await regen({
    request: new Request("http://x/api/account/recovery", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookieFor(id) },
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
    // The whole point: a 200 from redemption alone passed while this flow was a dead end.
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    const rAuth = await deriveAuthHash("CODE-1", a.rSalt);

    expect((await redeem({ email: "a@example.com", recoveryAuthHash: rAuth, newCredential: nc.body })).status).toBe(200);

    const login = await signIn("a@example.com", await deriveAuthHash("brand-new", nc.salt));
    expect(login.status).toBe(200);
  });

  it("re-wraps the SAME account key, so the record still opens", async () => {
    // A new keypair would orphan every envelope wrapped to the old public key.
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });

    const cred = await getCredential(w.db, a.id, "password");
    const recovered = await unwrapPrivateKey(cred!.wrappedPrivateKey, await deriveKekFromPassword("brand-new", nc.salt));
    const before = await crypto.subtle.exportKey("pkcs8", a.privateKey);
    const after = await crypto.subtle.exportKey("pkcs8", recovered);
    expect(Buffer.from(after).toString("base64")).toBe(Buffer.from(before).toString("base64"));
  });

  it("kills the old password", async () => {
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const oldCred = await getCredential(w.db, a.id, "password");
    const oldSalt = hexToBytes((oldCred!.kdfParams as any).salt);
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });

    expect((await signIn("a@example.com", await deriveAuthHash("forgotten", oldSalt))).status).toBe(401);
  });

  it("revokes sessions issued under the old password (RECOVERY.md I5)", async () => {
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    expect(await sessionsValidFrom(w.db, a.id)).toBeNull();
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });
    expect(await sessionsValidFrom(w.db, a.id)).toBeTruthy();
  });

  it("still issues a cookie that survives the revocation it just performed", async () => {
    // requireSession, not verifySession: the pure HMAC check passes whichever order revoke and mint ran in.
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
    // Only Date is faked — Miniflare needs real timers. Session iat has one-second resolution.
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const stale = await cookieFor(a.id);
    vi.setSystemTime(Date.now() + 1000);
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });

    const { requireSession } = await import("../../functions/_lib/session");
    const res = await requireSession(new Request("http://x/api/account", { headers: { cookie: stale } }), env());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it("leaves the passkey and Google credentials alone — they wrap the same key", async () => {
    // Unlike provider-issued recovery, which mints a NEW keypair and so must clear them.
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    await putCredential(w.db, { accountId: a.id, method: "passkey", wrappedPrivateKey: rand(48), kdfParams: { credentialID: "c1" } });
    const nc = await newCredentialFor(a.privateKey, "brand-new");
    await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt), newCredential: nc.body });
    expect(await getCredential(w.db, a.id, "passkey")).not.toBeNull();
  });
});

describe("the replacement is authorised by the code, not by a session", () => {
  it("refuses to install a password when the recovery code is wrong", async () => {
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const nc = await newCredentialFor(a.privateKey, "attacker-chosen");
    const res = await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("WRONG", a.rSalt), newCredential: nc.body });
    expect(res.status).toBe(401);

    // …and nothing was written. A route that verified after writing would hand the account away.
    const oldCred = await getCredential(w.db, a.id, "password");
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
    // The client redeems twice: once to obtain the wrapped key, once to install the re-wrapped one.
    const a = await seed("a@example.com", "forgotten", "CODE-1");
    const res = await redeem({ email: "a@example.com", recoveryAuthHash: await deriveAuthHash("CODE-1", a.rSalt) });
    expect(res.status).toBe(200);
    expect((await res.json() as any).wrappedPrivateKey).toBeTruthy();
    expect(await sessionsValidFrom(w.db, a.id)).toBeNull(); // nothing replaced, nothing revoked
  });
});

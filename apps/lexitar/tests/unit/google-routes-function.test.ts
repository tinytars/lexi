import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { onRequestGet as start } from "../../functions/api/auth/google/start";
import { onRequestGet as callback } from "../../functions/api/auth/google/callback";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { addIdentity, putPublicKey } from "../../functions/_lib/identity-credentials";
import { ORG_ACCOUNT_ID } from "../../functions/_lib/org";
import { verifyValue } from "../../functions/_lib/session";
import { generateAccountKeypair } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

// The Google OAuth routes, where the security decisions live: CSRF state, PKCE, email collisions, link binding.

const w = useWorkerd({ r2: true });
const CLIENT_ID = "client-1";
const GOOGLE_KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

beforeAll(async () => {
  await createAccount(w.db, { id: ORG_ACCOUNT_ID, displayName: "Org" });
  await putPublicKey(w.db, { accountId: ORG_ACCOUNT_ID, publicKeyJwk: (await generateAccountKeypair()).publicKeyJwk });
});
afterEach(() => vi.unstubAllGlobals());

const env = () => ({
  DB: w.db,
  VAULT: w.bucket,
  STORE_PREFIX: "test",
  SESSION_SECRET,
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: "secret",
  GOOGLE_KEK,
  GOOGLE_TOKEN_URL: "https://stub.invalid/token",
}) as never;

const setCookies = (res: Response) => res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
const cookieNamed = (res: Response, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`));

const idToken = (payload: Record<string, unknown>) =>
  `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

/** Stubs Google's token endpoint, returning an id_token built from `over`. */
function stubGoogle(over: Record<string, unknown> = {}, opts: { status?: number } = {}) {
  const seen: Record<string, string>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    seen.push(Object.fromEntries(new URLSearchParams(init?.body as string)));
    if (opts.status && opts.status !== 200) return new Response("no", { status: opts.status });
    const payload = {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: "google-sub-" + crypto.randomUUID(),
      email: null,
      email_verified: true,
      name: "G User",
      ...over,
    };
    return new Response(JSON.stringify({ id_token: idToken(payload) }), { status: 200 });
  });
  return seen;
}

/** Runs /start and returns the state cookie plus the parsed authorize URL. */
async function beginFlow(mode?: "link") {
  const res = await start({ request: new Request(`http://x/api/auth/google/start${mode ? `?mode=${mode}` : ""}`), env: env() });
  const cookie = cookieNamed(res, "hd_google_state")!;
  const value = cookie.split(";")[0].split("=").slice(1).join("=");
  const parsed = await verifyValue<{ state: string; nonce: string; codeVerifier: string; mode: string }>(SESSION_SECRET, value);
  return { res, cookieHeader: `hd_google_state=${value}`, parsed: parsed!, authUrl: new URL(res.headers.get("location")!) };
}

describe("/start hands Google a challenge only this browser can answer", () => {
  it("302s with state, nonce and an S256 PKCE challenge", async () => {
    const f = await beginFlow();
    expect(f.res.status).toBe(302);
    expect(f.authUrl.searchParams.get("state")).toBe(f.parsed.state);
    expect(f.authUrl.searchParams.get("nonce")).toBe(f.parsed.nonce);
    expect(f.authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(f.authUrl.searchParams.get("redirect_uri")).toBe("http://x/api/auth/google/callback");
  });

  it("the challenge is genuinely the hash of the verifier", async () => {
    // A challenge that is not S256(verifier) disables PKCE silently: Google accepts the pair it was
    // given and the interception protection is simply absent.
    const f = await beginFlow();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(f.parsed.codeVerifier)));
    const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(f.authUrl.searchParams.get("code_challenge")).toBe(expected);
  });

  it("mints a fresh state and nonce every time", async () => {
    const a = await beginFlow();
    const b = await beginFlow();
    expect(b.parsed.state).not.toBe(a.parsed.state);
    expect(b.parsed.nonce).not.toBe(a.parsed.nonce);
    expect(b.parsed.codeVerifier).not.toBe(a.parsed.codeVerifier);
  });

  it("keeps the verifier in an HttpOnly cookie, never in the URL", async () => {
    const f = await beginFlow();
    expect(cookieNamed(f.res, "hd_google_state")).toMatch(/HttpOnly/);
    expect(f.res.headers.get("location")).not.toContain(f.parsed.codeVerifier);
  });

  it("only the exact string `link` selects link mode", async () => {
    expect((await beginFlow("link")).parsed.mode).toBe("link");
    const res = await start({ request: new Request("http://x/api/auth/google/start?mode=LINK"), env: env() });
    const value = cookieNamed(res, "hd_google_state")!.split(";")[0].split("=").slice(1).join("=");
    expect((await verifyValue<{ mode: string }>(SESSION_SECRET, value))!.mode).toBe("login");
  });

  it("503s rather than starting a flow it cannot finish", async () => {
    const res = await start({ request: new Request("http://x/api/auth/google/start"), env: { ...(env() as object), GOOGLE_CLIENT_ID: "" } as never });
    expect(res.status).toBe(503);
  });
});

describe("/callback refuses anything it did not start", () => {
  const failsTo = (res: Response, error: string) => {
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`google_error=${error}`);
    // No session on any failure path, and the one-shot state cookie is always cleared.
    expect(cookieNamed(res, "hd_session")).toBeUndefined();
    expect(cookieNamed(res, "hd_google_state")).toMatch(/Max-Age=0/);
  };

  it("rejects a state that does not match the cookie (CSRF)", async () => {
    const f = await beginFlow();
    stubGoogle();
    const res = await callback({
      request: new Request("http://x/api/auth/google/callback?code=c&state=attacker-chosen", { headers: { cookie: f.cookieHeader } }),
      env: env(),
    });
    failsTo(res, "state");
  });

  it("rejects a callback with no state cookie at all", async () => {
    stubGoogle();
    const res = await callback({ request: new Request("http://x/api/auth/google/callback?code=c&state=s"), env: env() });
    failsTo(res, "state");
  });

  it("rejects a callback with no code", async () => {
    const f = await beginFlow();
    const res = await callback({
      request: new Request(`http://x/api/auth/google/callback?state=${f.parsed.state}`, { headers: { cookie: f.cookieHeader } }),
      env: env(),
    });
    failsTo(res, "state");
  });

  it("rejects a token whose nonce is not the one we sent — replay protection", async () => {
    const f = await beginFlow();
    stubGoogle({ nonce: "some-other-nonce" });
    const res = await callback({
      request: new Request(`http://x/api/auth/google/callback?code=c&state=${f.parsed.state}`, { headers: { cookie: f.cookieHeader } }),
      env: env(),
    });
    failsTo(res, "auth");
  });

  it("rejects a token minted for a different client_id", async () => {
    const f = await beginFlow();
    stubGoogle({ aud: "some-other-app", nonce: f.parsed.nonce });
    const res = await callback({
      request: new Request(`http://x/api/auth/google/callback?code=c&state=${f.parsed.state}`, { headers: { cookie: f.cookieHeader } }),
      env: env(),
    });
    failsTo(res, "auth");
  });

  it("surfaces a failed token exchange rather than proceeding", async () => {
    const f = await beginFlow();
    stubGoogle({}, { status: 400 });
    const res = await callback({
      request: new Request(`http://x/api/auth/google/callback?code=c&state=${f.parsed.state}`, { headers: { cookie: f.cookieHeader } }),
      env: env(),
    });
    failsTo(res, "auth");
  });

  it("sends the PKCE verifier when exchanging the code", async () => {
    const f = await beginFlow();
    const seen = stubGoogle({ nonce: f.parsed.nonce });
    await callback({
      request: new Request(`http://x/api/auth/google/callback?code=the-code&state=${f.parsed.state}`, { headers: { cookie: f.cookieHeader } }),
      env: env(),
    });
    expect(seen[0].code_verifier).toBe(f.parsed.codeVerifier);
    expect(seen[0].code).toBe("the-code");
    expect(seen[0].grant_type).toBe("authorization_code");
  });
});

describe("/callback signs in only who it should", () => {
  it("provisions a new account and sets a session", async () => {
    const f = await beginFlow();
    stubGoogle({ nonce: f.parsed.nonce });
    const res = await callback({
      request: new Request(`http://x/api/auth/google/callback?code=c&state=${f.parsed.state}`, { headers: { cookie: f.cookieHeader } }),
      env: env(),
    });
    expect(res.headers.get("location")).toContain("google=1");
    expect(cookieNamed(res, "hd_session")).toBeTruthy();
  });

  it("returns the SAME account on a second sign-in, rather than provisioning twice", async () => {
    const sub = "stable-sub-" + crypto.randomUUID();
    const signIn = async () => {
      const f = await beginFlow();
      stubGoogle({ nonce: f.parsed.nonce, sub });
      const res = await callback({
        request: new Request(`http://x/api/auth/google/callback?code=c&state=${f.parsed.state}`, { headers: { cookie: f.cookieHeader } }),
        env: env(),
      });
      const token = cookieNamed(res, "hd_session")!.split(";")[0].split("=").slice(1).join("=");
      return (await verifyValue<{ accountId: string }>(SESSION_SECRET, token))!.accountId;
    };
    expect(await signIn()).toBe(await signIn());
  });

  // The branch that matters most: the server holds no plaintext key for a client-custody account, so
  // it CANNOT link one. Signing the caller in on an email match would hand someone else's record to
  // whoever controls that Google address.
  it("refuses to sign in on an email collision with an existing account", async () => {
    const email = `collide-${crypto.randomUUID()}@x.test`;
    await createAccount(w.db, { id: crypto.randomUUID(), displayName: "Existing", email });

    const f = await beginFlow();
    stubGoogle({ nonce: f.parsed.nonce, email });
    const res = await callback({
      request: new Request(`http://x/api/auth/google/callback?code=c&state=${f.parsed.state}`, { headers: { cookie: f.cookieHeader } }),
      env: env(),
    });
    expect(res.headers.get("location")).toContain("google_error=email_exists");
    expect(cookieNamed(res, "hd_session")).toBeUndefined();
  });
});

describe("/callback link mode binds to the signed-in account, not to anything sent", () => {
  const popupError = async (res: Response) => {
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    return (await res.text()).match(/"error":"(\w+)"/)?.[1];
  };

  it("refuses to link when nobody is signed in", async () => {
    const f = await beginFlow("link");
    stubGoogle({ nonce: f.parsed.nonce });
    const res = await callback({
      request: new Request(`http://x/api/auth/google/callback?code=c&state=${f.parsed.state}`, { headers: { cookie: f.cookieHeader } }),
      env: env(),
    });
    expect(await popupError(res)).toBe("not_signed_in");
    expect(cookieNamed(res, "hd_google_link")).toBeUndefined();
  });

  it("refuses when the Google account already belongs to someone else", async () => {
    const owner = crypto.randomUUID();
    const other = crypto.randomUUID();
    for (const id of [owner, other]) await createAccount(w.db, { id, displayName: id });
    const sub = "owned-" + crypto.randomUUID();
    await addIdentity(w.db, { accountId: owner, method: "google", providerSubject: sub });

    const f = await beginFlow("link");
    stubGoogle({ nonce: f.parsed.nonce, sub });
    const res = await callback({
      request: new Request(`http://x/api/auth/google/callback?code=c&state=${f.parsed.state}`, {
        headers: { cookie: `${f.cookieHeader}; ${await cookieFor(other)}` },
      }),
      env: env(),
    });
    expect(await popupError(res)).toBe("linked_elsewhere");
    expect(cookieNamed(res, "hd_google_link")).toBeUndefined();
  });

  it("binds the link cookie to the SESSION's account and the VERIFIED sub", async () => {
    // The finishing POST reads this cookie rather than its own body, so this is the only place the
    // pairing is decided. A cookie carrying a caller-supplied account would be an account takeover.
    const me = crypto.randomUUID();
    await createAccount(w.db, { id: me, displayName: "Me" });
    const sub = "fresh-" + crypto.randomUUID();

    const f = await beginFlow("link");
    stubGoogle({ nonce: f.parsed.nonce, sub });
    const res = await callback({
      request: new Request(`http://x/api/auth/google/callback?code=c&state=${f.parsed.state}`, {
        headers: { cookie: `${f.cookieHeader}; ${await cookieFor(me)}` },
      }),
      env: env(),
    });

    const raw = cookieNamed(res, "hd_google_link")!.split(";")[0].split("=").slice(1).join("=");
    const linked = await verifyValue<{ accountId: string; sub: string }>(SESSION_SECRET, raw);
    expect(linked).toMatchObject({ accountId: me, sub });
    // A link must never also sign anyone in.
    expect(cookieNamed(res, "hd_session")).toBeUndefined();
  });
});

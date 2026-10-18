import { signValue, verifyValue, parseCookie, verifySession, signSession, sessionSetCookie } from "../../../_lib/session";
import { logRequest } from "../../../_lib/log";
import {
  verifyIdTokenClaims,
  provisionGoogleAccount,
  type GoogleClaims,
} from "../../../_lib/google";
import type { D1Database } from "../../../_lib/identity-types";
import { getAccountByEmail } from "../../../_lib/identity-accounts";
import { getIdentityByProviderSubject } from "../../../_lib/identity-credentials";

// W45 §J — Google OAuth callback. Verifies the signed state cookie (CSRF), exchanges the code for an
// id_token, verifies its claims, then branches:
//   mode=login → returning login (sub match) OR JIT-provision a new account → set session, redirect /?google=1
//   mode=link  → set a signed cookie {accountId,sub} and return a popup-closing page; the SPA (which
//                holds the private key) finishes the link via POST /api/account/methods/google.
// Email collision on a NEW login is NOT auto-linked (the server can't wrap a client-only account's
// key) — it redirects with google_error=email_exists so the user signs in and links from Account.
interface Env {
  DB: D1Database;
  VAULT: { put(key: string, value: Uint8Array): Promise<unknown> };
  STORE_PREFIX: string;
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_KEK: string;
  GOOGLE_TOKEN_URL?: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/google/callback";
const STATE_COOKIE = "hd_google_state";
const LINK_COOKIE = "hd_google_link";
const clearState = `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

function redirect(to: string, cookies: string[]): Response {
  const headers = new Headers({ location: to });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

// Popup response for the link flow — messages the opener SPA and closes itself.
function popupResult(origin: string, message: { type: string; error?: string }, cookies: string[]): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const c of cookies) headers.append("set-cookie", c);
  const body = `<!doctype html><meta charset="utf-8"><body><script>
    (function(){ try { if (window.opener) window.opener.postMessage(${JSON.stringify(message)}, ${JSON.stringify(origin)}); } catch (e) {}
    window.close(); })();
  </script>You can close this window.</body>`;
  return new Response(body, { headers });
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  const stateCookie = parseCookie(request.headers.get("cookie"), STATE_COOKIE);
  const state = await verifyValue<{ state: string; nonce: string; codeVerifier: string; mode: string }>(env.SESSION_SECRET, stateCookie);
  if (!state || !code || !stateParam || stateParam !== state.state) {
    log(400, "bad_state");
    return redirect(`${origin}/?google_error=state`, [clearState]);
  }
  const linkMode = state.mode === "link";

  let claims: GoogleClaims;
  try {
    const tokenUrl = env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${origin}/api/auth/google/callback`,
        grant_type: "authorization_code",
        code_verifier: state.codeVerifier,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
    const tok = (await tokenRes.json()) as { id_token?: string };
    if (!tok.id_token) throw new Error("no id_token");
    claims = verifyIdTokenClaims(tok.id_token, { clientId: env.GOOGLE_CLIENT_ID, nonce: state.nonce });
  } catch {
    log(400, "token_exchange_failed");
    const cookies = [clearState];
    return linkMode ? popupResult(origin, { type: "hd-google-error", error: "auth" }, cookies) : redirect(`${origin}/?google_error=auth`, cookies);
  }

  if (linkMode) {
    // Must be an authenticated in-app action (the popup shares the session cookie with the opener).
    const session = await verifySession(env, parseCookie(request.headers.get("cookie"), "hd_session"));
    if (!session) {
      log(401, "link_unauthenticated");
      return popupResult(origin, { type: "hd-google-error", error: "not_signed_in" }, [clearState]);
    }
    const existing = await getIdentityByProviderSubject(env.DB, "google", claims.sub);
    if (existing && existing.accountId !== session.accountId) {
      log(409, "sub_linked_elsewhere");
      return popupResult(origin, { type: "hd-google-error", error: "linked_elsewhere" }, [clearState]);
    }
    // Bind the verified sub to THIS account in a signed cookie; the finishing POST reads it (not the body).
    const linkCookie = await signValue(env.SESSION_SECRET, { accountId: session.accountId, sub: claims.sub, email: claims.email, emailVerified: claims.emailVerified }, 600);
    log(200);
    return popupResult(origin, { type: "hd-google-linked" }, [
      clearState,
      `${LINK_COOKIE}=${linkCookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    ]);
  }

  // login / JIT-signup
  try {
    const linked = await getIdentityByProviderSubject(env.DB, "google", claims.sub);
    let accountId: string;
    if (linked) {
      accountId = linked.accountId;
    } else {
      if (claims.email && (await getAccountByEmail(env.DB, claims.email))) {
        // Can't auto-link (no plaintext key server-side); route the user to sign in + link from Account.
        log(409, "email_exists");
        return redirect(`${origin}/?google_error=email_exists`, [clearState]);
      }
      ({ accountId } = await provisionGoogleAccount(
        { db: env.DB, vault: env.VAULT, storePrefix: env.STORE_PREFIX, googleKekB64: env.GOOGLE_KEK },
        claims,
      ));
    }
    const token = await signSession(env, accountId);
    log(200);
    return redirect(`${origin}/?google=1`, [clearState, sessionSetCookie(token)]);
  } catch {
    log(500, "google_login_failed");
    return redirect(`${origin}/?google_error=server`, [clearState]);
  }
}

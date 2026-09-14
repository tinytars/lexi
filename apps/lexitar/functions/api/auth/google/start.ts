import { signValue } from "../../../_lib/session";
import { logRequest } from "../../../_lib/log";

// W45 §J — begin the Google OAuth (OIDC) flow. Generates state + nonce + PKCE, stashes them in a
// short-TTL signed cookie (no server-side store), and 302s to Google. `mode=link` is the in-app
// "add Google to my account" popup flow; default is login/JIT-signup.
interface Env {
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_AUTH_URL?: string; // override for tests/stub IdP; defaults to Google
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/google/start";
const STATE_COOKIE = "hd_google_state";
const subtle = (globalThis.crypto as Crypto).subtle;
const enc = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  if (!env.GOOGLE_CLIENT_ID) {
    log(503, "google_not_configured");
    return new Response("Google sign-in is not configured", { status: 503 });
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") === "link" ? "link" : "login";
  const redirectUri = `${url.origin}/api/auth/google/callback`;

  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const codeVerifier = bytesToBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(48)));
  const challenge = bytesToBase64Url(new Uint8Array(await subtle.digest("SHA-256", enc.encode(codeVerifier))));

  const cookie = await signValue(env.SESSION_SECRET, { state, nonce, codeVerifier, mode }, 600);

  const authBase = env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
  const authUrl = new URL(authBase);
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("prompt", "select_account");

  log(302);
  return new Response(null, {
    status: 302,
    headers: {
      location: authUrl.toString(),
      "set-cookie": `${STATE_COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}

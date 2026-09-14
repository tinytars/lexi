// W44 P2 — signed-cookie session over HMAC-SHA256 (WebCrypto). The cookie itself carries
// {accountId, iat, exp}, verified by recomputing the HMAC against SESSION_SECRET. Mirrors the
// constant-time-compare pattern in guard.ts.
//
// W71 — this header used to open "No D1/KV lookup per request", stated as a feature. It was also the
// reason a session could not be revoked: with nothing on the server to check against, a captured
// cookie stayed valid for its full 30-day TTL through logout, a password change and a passkey
// removal, and the only lever was rotating SESSION_SECRET — which signs out every account at once and
// simultaneously invalidates email-verification tokens and WebAuthn challenges, since all five token
// types share that one secret.
//
// `requireSession` therefore now costs one primary-key read (accounts.sessions_valid_from). The DB is
// a REQUIRED part of SessionEnv rather than an optional extra, deliberately: an optional check is one
// a route can forget, and a route that forgets it is indistinguishable from the old behaviour.
// `verifySession` remains the pure signature check, for the callers that are minting rather than
// authorising.

import type { D1Database } from "./identity-types";
import { sessionsValidFrom } from "./identity-accounts";
import { bytesToBase64Url, timingSafeEqualStr } from "./verifier";

export interface SessionEnv {
  SESSION_SECRET: string;
  DB: D1Database;
}

const subtle = (globalThis.crypto as Crypto).subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const COOKIE_NAME = "hd_session";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;


function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Length-guarded constant-time compare (same rationale as guard.ts: Workers has no
// Node crypto.timingSafeEqual).

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await subtle.sign("HMAC", key, enc.encode(payload)));
  return bytesToBase64Url(sig);
}

export async function signSession(
  env: { SESSION_SECRET: string },
  accountId: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<string> {
  return signValue(env.SESSION_SECRET, { accountId }, ttlSeconds);
}

/** Signature + expiry only. Says the cookie is authentic, NOT that it is still honoured. */
export async function verifySession(
  env: { SESSION_SECRET: string },
  token: string | null | undefined
): Promise<{ accountId: string; iat: number } | null> {
  const parsed = await verifyValue<{ accountId?: unknown; iat?: unknown }>(env.SESSION_SECRET, token);
  if (!parsed || typeof parsed.accountId !== "string" || !parsed.accountId) return null;
  if (typeof parsed.iat !== "number") return null;
  return { accountId: parsed.accountId, iat: parsed.iat };
}

// Generic signed-JSON-value helpers (same HMAC scheme as signSession/verifySession above)
// so other cookies — e.g. the WebAuthn challenge cookie in webauthn.ts — don't reimplement
// the HMAC. `data` gets `iat`/`exp` merged in; verify rejects a bad signature or an expired value.
export async function signValue(secret: string, data: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const payload = bytesToBase64Url(enc.encode(JSON.stringify({ ...data, iat, exp: iat + ttlSeconds })));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyValue<T extends Record<string, unknown>>(
  secret: string,
  token: string | null | undefined
): Promise<T | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;

  const expectedSig = await hmac(secret, payload);
  if (!timingSafeEqualStr(sig, expectedSig)) return null;

  let parsed: { exp?: unknown };
  try {
    parsed = JSON.parse(dec.decode(base64UrlToBytes(payload)));
  } catch {
    return null;
  }
  if (typeof parsed.exp !== "number" || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
  return parsed as T;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export async function requireSession(request: Request, env: SessionEnv): Promise<{ accountId: string } | Response> {
  const token = parseCookie(request.headers.get("cookie"), COOKIE_NAME);
  const session = await verifySession(env, token);
  if (!session) return unauthorized();

  // Issued before the account last revoked its sessions — logout, a replaced password, a removed
  // passkey, a changed email, or an account that no longer exists at all.
  const validFrom = await sessionsValidFrom(env.DB, session.accountId);
  if (validFrom !== null && session.iat < validFrom) return unauthorized();

  return { accountId: session.accountId };
}

export function sessionSetCookie(token: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`;
}

// Expire the session cookie (logout): same attributes as sessionSetCookie with Max-Age=0 so
// the browser drops it immediately.
export function sessionClearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

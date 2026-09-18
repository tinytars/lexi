// W44 P3 — thin wrapper over @simplewebauthn/server for passkey register/login, plus the
// signed challenge cookie (reuses session.ts's signValue/verifyValue HMAC scheme).
//
// PRF extension gotcha: @simplewebauthn/server@13's AuthenticationExtensionsClientInputs/
// Outputs types (types/dom.ts) don't include `prf` — the spec extension isn't in their DOM
// type shim yet. We pass it through with a cast. More importantly, @simplewebauthn/browser's
// startRegistration/startAuthentication spread `optionsJSON.extensions` verbatim into
// navigator.credentials.{create,get}() — unlike challenge/user.id/excludeCredentials, they do
// NOT base64url-decode custom extensions. So `eval.first` travels server→client as a base64url
// STRING (JSON-safe), and the CLIENT (src/lib/auth-client.ts) must decode it back into a
// BufferSource itself before calling start*(). See auth-client.ts's `preparePrfExtension`.
import {
  generateRegistrationOptions as swanGenerateRegistrationOptions,
  verifyRegistrationResponse as swanVerifyRegistrationResponse,
  generateAuthenticationOptions as swanGenerateAuthenticationOptions,
  verifyAuthenticationResponse as swanVerifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
  WebAuthnCredential,
  AuthenticatorTransport,
} from "@simplewebauthn/server";
import { signValue, verifyValue, parseCookie } from "./session";

export interface WebauthnEnv {
  WEBAUTHN_RP_ID: string;
  WEBAUTHN_RP_NAME: string;
  WEBAUTHN_ORIGIN: string;
  SESSION_SECRET: string;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function prfExtension(prfSalt: Uint8Array): Record<string, unknown> {
  return { prf: { eval: { first: bytesToBase64Url(prfSalt) } } };
}

export async function generateRegistrationOptions(
  env: WebauthnEnv,
  opts: { email: string; displayName: string; prfSalt: Uint8Array }
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return swanGenerateRegistrationOptions({
    rpName: env.WEBAUTHN_RP_NAME,
    rpID: env.WEBAUTHN_RP_ID,
    userName: opts.email,
    userDisplayName: opts.displayName,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    extensions: prfExtension(opts.prfSalt) as unknown as Parameters<typeof swanGenerateRegistrationOptions>[0]["extensions"],
  });
}

export async function verifyRegistrationResponse(
  env: WebauthnEnv,
  response: RegistrationResponseJSON,
  expectedChallenge: string
): Promise<VerifiedRegistrationResponse> {
  return swanVerifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: env.WEBAUTHN_ORIGIN,
    expectedRPID: env.WEBAUTHN_RP_ID,
  });
}

export async function generateAuthenticationOptions(
  env: WebauthnEnv,
  opts: { credentialId: string; transports?: AuthenticatorTransport[]; prfSalt: Uint8Array }
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return swanGenerateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    allowCredentials: [{ id: opts.credentialId, transports: opts.transports }],
    userVerification: "preferred",
    extensions: prfExtension(opts.prfSalt) as unknown as Parameters<typeof swanGenerateAuthenticationOptions>[0]["extensions"],
  });
}

export async function verifyAuthenticationResponse(
  env: WebauthnEnv,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: WebAuthnCredential
): Promise<VerifiedAuthenticationResponse> {
  return swanVerifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: env.WEBAUTHN_ORIGIN,
    expectedRPID: env.WEBAUTHN_RP_ID,
    credential,
  });
}

// ── Challenge cookie ─────────────────────────────────────────────────────────────────────
// Short-lived (5 min), HMAC-signed over the same scheme as hd_session — see session.ts.

const CHALLENGE_COOKIE = "hd_webauthn_chal";
const CHALLENGE_TTL_SECONDS = 300;

export interface ChallengeCookiePayload {
  challenge: string;
  email: string;
  displayName?: string;
  prfSalt: string; // hex
}

export async function setChallengeCookie(env: WebauthnEnv, payload: ChallengeCookiePayload): Promise<string> {
  // signValue's `Record<string, unknown>` param wants an index signature; ChallengeCookiePayload
  // is a closed interface (deliberately, so callers get field-name typo-checking) — cast at this
  // one boundary rather than loosening either type.
  const token = await signValue(env.SESSION_SECRET, payload as unknown as Record<string, unknown>, CHALLENGE_TTL_SECONDS);
  return `${CHALLENGE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${CHALLENGE_TTL_SECONDS}`;
}

export async function readChallengeCookie(env: WebauthnEnv, request: Request): Promise<ChallengeCookiePayload | null> {
  const token = parseCookie(request.headers.get("cookie"), CHALLENGE_COOKIE);
  const parsed = await verifyValue<Record<string, unknown>>(env.SESSION_SECRET, token);
  if (!parsed || typeof parsed.challenge !== "string" || typeof parsed.email !== "string" || typeof parsed.prfSalt !== "string") {
    return null;
  }
  return parsed as unknown as ChallengeCookiePayload;
}

export function clearChallengeCookie(): string {
  return `${CHALLENGE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

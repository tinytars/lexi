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
    // generateRegistrationOptions above asks for userVerification "preferred", so an authenticator
    // that performs none is answering exactly as invited — but @simplewebauthn defaults
    // requireUserVerification to TRUE and THROWS when the flag is clear. That disagreement reached
    // production: a real add-a-passkey on the live site threw "User verification was required, but
    // user could not be verified" and became an unhandled 500 (plover-factory#65, 2026-10-17).
    // The verifier follows the policy the options state. Tightening it means changing BOTH ends, so
    // that a device which cannot verify its user is refused by the browser, with a prompt, instead
    // of by the server after the person has already touched their key.
    requireUserVerification: false,
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
    // Same reason as the registration verifier above: generateAuthenticationOptions asks for
    // "preferred", so requiring it here would refuse a sign-in with the very passkey this app
    // agreed to register.
    requireUserVerification: false,
  });
}

/**
 * What to answer when @simplewebauthn THROWS instead of returning `verified: false`. It throws for
 * most failed expectations — challenge, origin, RP ID, user verification, attestation format — and
 * a throw escaping a route reaches functions/api/_middleware.ts, which answers `internal error`
 * and files a GitHub issue. That is what the Account panel showed a person adding a passkey on
 * 2026-10-17 (plover-factory#65): a dead end with nothing to do about it.
 *
 * Every one of these is the request being refused rather than the server breaking, so the caller
 * gets a sentence it can show and a code it can log. The message says what to do where there is
 * something to do, and says nothing changed where there is not.
 */
export function passkeyVerifyFailure(error: unknown): { errorCode: string; message: string } {
  const text = error instanceof Error ? error.message : String(error);
  if (/challenge/i.test(text))
    return { errorCode: "challenge_mismatch", message: "That request expired before your device finished. Try again." };
  if (/user verif/i.test(text))
    return { errorCode: "uv_unverified", message: "Your device did not confirm it was you. Unlock it with your fingerprint, face or PIN, then try again." };
  if (/origin|rp ?id/i.test(text))
    return { errorCode: "host_mismatch", message: "Passkeys are not set up for this web address, so this one could not be saved. Nothing changed." };
  return { errorCode: "attestation_rejected", message: "This device's passkey could not be verified. Nothing changed, and your other ways in still work." };
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

// W45 §J — Google OAuth account custody. UNLIKE password/passkey (zero-knowledge: the vault key
// never reaches the server), a Google account has NO client-side secret to derive a KEK from, so the
// account's ECDH private key is wrapped by a SERVER-HELD KEK (`GOOGLE_KEK`, a Pages secret, never in
// D1). Consequence: the operator CAN unwrap a Google-custody vault. This is the owner-accepted weaker
// posture (see docs/health-dash/plans/45-w45-google-oauth-onboarding.md). Everything crypto lives in
// src/lib/crypto — this module only wires it to the D1/R2 writers and the server KEK.
import {
  generateAccountKeypair,
  wrapPrivateKey,
  unwrapPrivateKey,
  importPrivateKeyPkcs8,
  generateDEK,
  encryptVaultV2,
  wrapDEKForPublicKey,
} from "@tinytars/vault/crypto";
import type { D1Database } from "./identity-types";
import { createAccount, setEmailConfirmed } from "./identity-accounts";
import { addIdentity, getCredential, getIdentityByProviderSubject, getPublicKey, putCredential, putPublicKey } from "./identity-credentials";
import { createVault, getEnvelope, listVaultsForOwner, putEnvelope } from "./identity-vault";
import { toArrayBuffer } from "./bytes";
import { emitLifecycleEvent } from "./lifecycle";
import { storeKey } from "./store";
import { ORG_ACCOUNT_ID } from "./org";

const subtle = (globalThis.crypto as Crypto).subtle;
const enc = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return base64ToBytes(b64 + pad);
}

export interface GoogleClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

// Per-account server KEK = HKDF(GOOGLE_KEK, salt=accountId). Per-account so a single leaked wrapped
// key isn't fungible across accounts. GOOGLE_KEK is base64 of >=32 random bytes (a Pages secret).
export async function deriveGoogleKek(googleKekB64: string, accountId: string): Promise<CryptoKey> {
  const ikm = base64ToBytes(googleKekB64.trim());
  const baseKey = await subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(accountId), info: enc.encode("google-kek-v1") },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// Decode (NOT signature-verify) an id_token payload. W45 v1 trusts the token because it came directly
// from Google's token endpoint over TLS (server-to-server), per Google's OpenID guidance; full JWKS
// RS256 verification is a documented follow-up. Claim checks below are still mandatory.
export function parseIdToken(idToken: string): GoogleClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]))) as Record<string, unknown>;
  const claims: GoogleClaims = {
    sub: String(payload.sub ?? ""),
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: typeof payload.name === "string" ? payload.name : null,
  };
  if (!claims.sub) throw new Error("id_token missing sub");
  return { ...claims, __raw: payload } as GoogleClaims & { __raw: Record<string, unknown> };
}

export function verifyIdTokenClaims(idToken: string, opts: { clientId: string; nonce: string }): GoogleClaims {
  const claims = parseIdToken(idToken) as GoogleClaims & { __raw: Record<string, unknown> };
  const p = claims.__raw;
  const iss = String(p.iss ?? "");
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") throw new Error("bad iss");
  const aud = Array.isArray(p.aud) ? p.aud.map(String) : [String(p.aud ?? "")];
  if (!aud.includes(opts.clientId)) throw new Error("bad aud");
  const exp = typeof p.exp === "number" ? p.exp : 0;
  if (exp <= Math.floor(Date.now() / 1000)) throw new Error("id_token expired");
  if (String(p.nonce ?? "") !== opts.nonce) throw new Error("nonce mismatch");
  return { sub: claims.sub, email: claims.email, emailVerified: claims.emailVerified, name: claims.name };
}

export interface GoogleDeps {
  db: D1Database;
  vault: { put(key: string, value: Uint8Array): Promise<unknown> };
  storePrefix: string;
  googleKekB64: string;
}

// First Google login: server-side mirror of password/signup.ts, but the private key is wrapped under
// the server KEK (no client secret exists). Returns the new account/vault ids.
export async function provisionGoogleAccount(deps: GoogleDeps, claims: GoogleClaims): Promise<{ accountId: string; vaultId: string }> {
  const accountId = crypto.randomUUID();
  const vaultId = crypto.randomUUID();
  const r2Key = `data-${vaultId}.enc`;

  const { publicKeyJwk, privateKey } = await generateAccountKeypair();
  const kek = await deriveGoogleKek(deps.googleKekB64, accountId);
  const wrappedPrivateKey = await wrapPrivateKey(privateKey, kek);

  const dek = await generateDEK();
  const vaultBlob = await encryptVaultV2({ clients: {} }, dek);
  const ownerEnvelope = await wrapDEKForPublicKey(dek, publicKeyJwk);

  // W55 P4 — fail the whole provision rather than silently create a one-envelope account; a Google
  // signup with no org-recovery envelope would be unrecoverable in a way password/passkey signups
  // (which the client-side crypto guarantees to wrap) never are.
  const orgKey = await getPublicKey(deps.db, ORG_ACCOUNT_ID);
  if (!orgKey) throw new Error("missing org public key");
  const orgEnvelope = await wrapDEKForPublicKey(dek, orgKey.publicKeyJwk as JsonWebKey);

  await createAccount(deps.db, {
    id: accountId,
    displayName: claims.name || claims.email || "New member",
    email: claims.email,
    lifecycleStage: "active",
  });
  // W47 — Google already verified this address, so mark it confirmed and skip our own verification email.
  if (claims.email && claims.emailVerified) await setEmailConfirmed(deps.db, accountId, true);
  await addIdentity(deps.db, { accountId, method: "google", providerSubject: claims.sub });
  // kdf_params holds only the KEK marker — the wrapping secret is the server KEK, not derived here.
  await putCredential(deps.db, { accountId, method: "google", wrappedPrivateKey, kdfParams: { kek: "google-hkdf-v1" } });
  await putPublicKey(deps.db, { accountId, publicKeyJwk });
  await createVault(deps.db, { vaultId, ownerAccountId: accountId, r2Key, hd1Version: 2 });
  await putEnvelope(deps.db, {
    vaultId,
    principalAccountId: accountId,
    wrappedDek: ownerEnvelope.wrappedDEK,
    ephemeralPublicKeyJwk: ownerEnvelope.ephemeralPublicKeyJwk,
    createdBy: accountId,
  });
  await putEnvelope(deps.db, {
    vaultId,
    principalAccountId: ORG_ACCOUNT_ID,
    wrappedDek: orgEnvelope.wrappedDEK,
    ephemeralPublicKeyJwk: orgEnvelope.ephemeralPublicKeyJwk,
    createdBy: accountId,
  });
  // D1 rows then R2 put — same non-atomicity as password/signup.ts; no worse.
  await deps.vault.put(storeKey({ STORE_PREFIX: deps.storePrefix }, r2Key), vaultBlob);
  await emitLifecycleEvent(deps.db, accountId, "signup");

  return { accountId, vaultId };
}

export interface GoogleKeyMaterial {
  accountId: string;
  vaultId: string | null;
  r2Key: string | null;
  rotationPending: boolean;
  privateKeyPkcs8: string; // base64 — PLAINTEXT key, handed to the client over the authenticated channel
  ownerEnvelope: { wrappedDEK: string; ephemeralPublicKeyJwk: unknown } | null;
}

// Bootstrap: unwrap the account's private key with the server KEK and return it (plaintext) plus the
// owner envelope, so the authenticated client can recover the DEK. This is the server-assisted step
// that has no counterpart in the zero-knowledge password/passkey path.
export async function loadGoogleKeyMaterial(db: D1Database, accountId: string, googleKekB64: string): Promise<GoogleKeyMaterial> {
  const cred = await getCredential(db, accountId, "google");
  if (!cred) throw new Error("no google credential on this account");
  const kek = await deriveGoogleKek(googleKekB64, accountId);
  const privateKey = await unwrapPrivateKey(cred.wrappedPrivateKey, kek);
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", privateKey));

  const vault = (await listVaultsForOwner(db, accountId))[0] ?? null;
  const envelope = vault ? await getEnvelope(db, vault.vaultId, accountId) : null;
  return {
    accountId,
    vaultId: vault?.vaultId ?? null,
    r2Key: vault?.r2Key ?? null,
    rotationPending: vault?.rotationPending ?? false,
    privateKeyPkcs8: bytesToBase64(pkcs8),
    ownerEnvelope: envelope
      ? { wrappedDEK: bytesToBase64(envelope.wrappedDek), ephemeralPublicKeyJwk: envelope.ephemeralPublicKeyJwk }
      : null,
  };
}

// Add Google to an EXISTING (password/passkey) account. The server can't wrap that account's private
// key itself (it never holds the plaintext), so the logged-in client supplies its in-memory private
// key here; the server wraps it under the server KEK. `sub` comes from a signed cookie, never the body.
export async function linkGoogleToAccount(
  db: D1Database,
  accountId: string,
  sub: string,
  privateKeyPkcs8B64: string,
  googleKekB64: string,
): Promise<void> {
  const existing = await getIdentityByProviderSubject(db, "google", sub);
  if (existing && existing.accountId !== accountId) throw new Error("this Google identity is already linked to another account");

  const kek = await deriveGoogleKek(googleKekB64, accountId);
  const privateKey = await importPrivateKeyPkcs8(base64ToBytes(privateKeyPkcs8B64));
  const wrappedPrivateKey = await wrapPrivateKey(privateKey, kek);
  await putCredential(db, { accountId, method: "google", wrappedPrivateKey, kdfParams: { kek: "google-hkdf-v1" } });
  if (!existing) await addIdentity(db, { accountId, method: "google", providerSubject: sub });
}

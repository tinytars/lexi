// The first non-browser client of this app's own API: sign in as a principal, unwrap that
// principal's key locally, and hand back an authenticated connection.
//
// The server holds no key and structurally cannot decrypt (ARCHITECTURE.md), so a CLI that wants to
// read a record has exactly one honest route in — the same one the browser takes. It proves who it
// is with `deriveAuthHash`, receives its own sealed copy of the DEK, and unseals it here. Nothing is
// added server-side and the CLI gains no reach the account's own browser does not already have:
// the ciphertext arrives through GET /api/vault/{id}, so `resolveEnvelopeAccess` stays in the path.
//
// NOT @tinytars/vault's `loginPassword`, which is the same chain but browser-bound three ways —
// relative fetch URLs, it discards `set-cookie`, and the module imports @simplewebauthn/browser. The
// primitives it calls are reused instead; the wiring is the only thing written here.
//
// The passphrase and the session cookie live in memory for the run and are never written to disk.
// `hd_session` has a 30-day TTL and the only revocation lever is bumping
// `accounts.sessions_valid_from`, so a cached cookie would be a month-long bearer token in a file —
// strictly worse than re-deriving from the passphrase each run.
import {
  decryptVaultV2,
  deriveAuthHash,
  deriveKekFromPassword,
  unwrapDEKWithPrivateKey,
  unwrapPrivateKey,
} from "@tinytars/vault/crypto";
import { b64ToBytes, hexToBytes } from "./org-key";
import { vaultIdFromR2Key } from "../src/lib/client-id";
import type { Vault } from "../src/lib/types";
import "./load-creds";

export interface CliCredentials {
  baseUrl: string;
  email: string;
  password: string;
  /** Cloudflare Access service token, when the target origin sits behind that perimeter. */
  accessClientId?: string;
  accessClientSecret?: string;
}

interface LoginResponse {
  accountId: string;
  vaultId: string | null;
  r2Key: string | null;
  rotationPending: boolean;
  wrappedPrivateKey: string;
  kdfParams: { salt: string; iterations: number };
  ownerEnvelope: {
    wrappedDEK: string;
    ephemeralPublicKeyJwk: JsonWebKey;
  } | null;
}

export interface Session extends LoginResponse {
  baseUrl: string;
  email: string;
  password: string;
  cookie: string;
  accessHeaders: Record<string, string>;
}

export interface OpenVault {
  vault: Vault;
  dek: CryptoKey;
  accountId: string;
  vaultId: string;
  /** The r2Key stem — what /api/vault/{id} takes, which is NOT the vault uuid after a rotation. */
  blobId: string;
  rotationPending: boolean;
}

/**
 * The credentials this CLI signs in with, from the operator's private credential store.
 *
 * `LEXITAR_BASE_URL` defaults to the local Functions dev server rather than to a deployment: the
 * default must not be the one that reads a real person's record. Set it explicitly to reach dev.
 */
export function cliCredentials(): CliCredentials {
  const email = process.env.LEXITAR_CLI_EMAIL;
  const password = process.env.LEXITAR_CLI_PASSWORD;
  if (!email || !password) {
    throw new Error("LEXITAR_CLI_EMAIL and LEXITAR_CLI_PASSWORD are not set — they belong in plover-keys/health-dash.env");
  }
  return {
    baseUrl: (process.env.LEXITAR_BASE_URL || "http://localhost:8788").replace(/\/$/, ""),
    email,
    password,
    accessClientId: process.env.CF_ACCESS_CLIENT_ID,
    accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
  };
}

function accessHeadersFor(creds: CliCredentials): Record<string, string> {
  return creds.accessClientId && creds.accessClientSecret
    ? {
        "cf-access-client-id": creds.accessClientId,
        "cf-access-client-secret": creds.accessClientSecret,
      }
    : {};
}

/**
 * Cloudflare Access fronts the deployed origin, and it refuses a headless client by REDIRECTING to a
 * login page — so the failure arrives as a 200 full of HTML rather than a 401, and every JSON parse
 * downstream fails somewhere unrelated to the cause. Named here once.
 */
function assertNotAccessWall(res: Response, url: string): void {
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return;
  throw new Error(
    `${url} answered ${res.status} ${type || "with no content type"} instead of JSON — the origin is ` +
      "probably behind Cloudflare Access. Set CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET to a service " +
      "token, or point LEXITAR_BASE_URL at http://localhost:8788 (npm run dev:functions).",
  );
}

function sessionCookie(res: Response): string {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const token = all.map((c) => /(?:^|;\s*)hd_session=([^;]*)/.exec(c)?.[1]).find((v) => v);
  if (!token) throw new Error("sign-in succeeded but no hd_session cookie came back");
  return `hd_session=${token}`;
}

/** Signs in and captures the session cookie. No key material is derived here beyond the auth proof. */
export async function login(creds: CliCredentials): Promise<Session> {
  const accessHeaders = accessHeadersFor(creds);
  const saltUrl = `${creds.baseUrl}/api/auth/password/salt?email=${encodeURIComponent(creds.email)}`;
  const saltRes = await fetch(saltUrl, { headers: accessHeaders });
  assertNotAccessWall(saltRes, saltUrl);
  if (!saltRes.ok) throw new Error(`sign-in is unavailable (${saltRes.status} from ${saltUrl})`);
  // A DECOY salt comes back for an unknown address, so a wrong email fails at unwrap rather than
  // here. Whatever fails below must therefore name the address as a possible cause.
  const { salt } = (await saltRes.json()) as { salt: string };

  const authHash = await deriveAuthHash(creds.password, hexToBytes(salt));
  const loginUrl = `${creds.baseUrl}/api/auth/password/login`;
  const res = await fetch(loginUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...accessHeaders },
    body: JSON.stringify({ email: creds.email, authHash }),
  });
  assertNotAccessWall(res, loginUrl);
  if (res.status === 401) {
    // login.ts returns the same 401 whether the password is wrong or the account has no `password`
    // credential at all, so this message must cover both — the CLI cannot tell them apart.
    throw new Error(
      `${creds.email} was rejected: the password is wrong, the address is unknown, or this account ` +
        "has no password credential (a passkey-only or Google-only account cannot be used from the CLI)",
    );
  }
  if (!res.ok) throw new Error(`sign-in failed (${res.status} from ${loginUrl})`);

  const data = (await res.json()) as LoginResponse;
  return {
    ...data,
    baseUrl: creds.baseUrl,
    email: creds.email,
    password: creds.password,
    cookie: sessionCookie(res),
    accessHeaders,
  };
}

/** A cookie-bearing fetch against the signed-in origin. `path` is absolute-from-root. */
export function authedFetch(session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${session.baseUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      ...session.accessHeaders,
      cookie: session.cookie,
    },
  });
}

/** Unwraps the account key, then the DEK, then decrypts the vault blob the session is entitled to. */
export async function openVault(session: Session): Promise<OpenVault> {
  if (!session.vaultId || !session.r2Key || !session.ownerEnvelope) {
    throw new Error(`${session.email} has no vault to export (the account exists but holds no record)`);
  }
  const blobId = vaultIdFromR2Key(session.r2Key);
  if (!blobId) throw new Error(`cannot address the vault: r2Key ${session.r2Key} is not a vault blob`);

  const kek = await deriveKekFromPassword(session.password, hexToBytes(session.kdfParams.salt));
  let dek: CryptoKey;
  try {
    const privateKey = await unwrapPrivateKey(b64ToBytes(session.wrappedPrivateKey), kek);
    dek = await unwrapDEKWithPrivateKey(
      b64ToBytes(session.ownerEnvelope.wrappedDEK),
      session.ownerEnvelope.ephemeralPublicKeyJwk,
      privateKey,
    );
  } catch {
    // The server verified `authHash`, which lives in a different KDF domain from the KEK — so a
    // failure here is a credential mismatch this account's own browser would hit too, not a bug.
    throw new Error(`the passphrase for ${session.email} does not open its account key`);
  }

  const res = await authedFetch(session, `/api/vault/${blobId}`);
  if (!res.ok) throw new Error(`cannot read vault ${blobId} (${res.status})`);
  const blob = new Uint8Array(await res.arrayBuffer());
  const vault = await decryptVaultV2<Vault>(blob, dek);

  return {
    vault,
    dek,
    accountId: session.accountId,
    vaultId: session.vaultId,
    blobId,
    rotationPending: session.rotationPending,
  };
}

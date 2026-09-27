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
//
// AND THE PASSPHRASE IS NOT IN THE CREDENTIALS REPO EITHER. A record's password is both its login
// secret and the KEK that unwraps its account key, which is why rotate-pilot-credentials.ts:26-27
// prints a new one once and stores it "nowhere — not in this repo, not in the credentials repo". A
// standing LEXITAR_CLI_PASSWORD for a real account would reinstate on one record exactly the shape
// the org key was rejected for: a file on a disk that opens someone's health data. So the default
// path prompts for it on the terminal, and the env var stays for the unattended case — a synthetic
// patient, whose password is a public literal (provision-e2e-patient.ts).
//
// THE ONE PASSWORD THAT MAY SIT IN THE CREDENTIALS REPO IS A SUPPORT PRINCIPAL'S — LEXITAR_SUPPORT_*,
// minted by provision-support-account.ts. The rule above is about an account that OWNS a record: there
// the password IS the key. A support account owns nothing, so its password opens nothing on its own. It
// lets the tool present itself, and it reaches a record only while a patient's approval is live, which
// expires by itself. The variable names are deliberately different so the rule above stays true rather
// than being softened into something weaker.
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
 * The account this CLI signs in as. The passphrase is deliberately allowed to be absent — see the
 * header and `withPassword`.
 *
 * `LEXITAR_BASE_URL` defaults to the local Functions dev server rather than to a deployment: the
 * default must not be the one that reads a real person's record. Set it explicitly to reach dev.
 */
export function cliCredentials(): CliCredentials {
  const email = process.env.LEXITAR_CLI_EMAIL;
  if (!email) throw new Error("set LEXITAR_CLI_EMAIL to the address of the account whose record this is");
  return { ...origin(), email, password: process.env.LEXITAR_CLI_PASSWORD ?? "" };
}

/**
 * The export CLI's own principal: a support account (scripts/provision-support-account.ts) that owns no
 * record and reads one only while a patient's approval is live. Both variables are required — unlike the
 * owner path there is nothing to prompt for, because a human is deliberately not present.
 */
export function supportCredentials(): CliCredentials {
  const email = process.env.LEXITAR_SUPPORT_EMAIL;
  const password = process.env.LEXITAR_SUPPORT_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "set LEXITAR_SUPPORT_EMAIL and LEXITAR_SUPPORT_PASSWORD to the record-export principal " +
        "(they are in plover-keys/health-dash.env, which scripts/load-creds.ts reads)",
    );
  }
  return { ...origin(), email, password };
}

function origin(): Omit<CliCredentials, "email" | "password"> {
  return {
    baseUrl: (process.env.LEXITAR_BASE_URL || "http://localhost:8788").replace(/\/$/, ""),
    accessClientId: process.env.CF_ACCESS_CLIENT_ID,
    accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
  };
}

/** Read a line from the terminal without echoing it, so it misses the scrollback and the logs. */
async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("no terminal to ask for the passphrase — set LEXITAR_CLI_PASSWORD for an unattended run");
  }
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const muted = (rl as unknown as { output: { write: (s: string) => void } }).output;
  const write = muted.write.bind(muted);
  process.stderr.write(prompt);
  muted.write = (s: string) => void (s.includes("\n") && write(s));
  try {
    return await new Promise<string>((done) => rl.question("", done));
  } finally {
    muted.write = write;
    rl.close();
  }
}

/**
 * The passphrase, from the environment when a caller set one and from the terminal otherwise.
 *
 * `ask` is a parameter so the suite can exercise both branches; nothing in production passes it.
 */
export async function withPassword(creds: CliCredentials, ask = promptHidden): Promise<CliCredentials> {
  if (creds.password) return creds;
  const password = (await ask(`passphrase for ${creds.email}: `)).trim();
  if (!password) throw new Error("no passphrase given");
  return { ...creds, password };
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
        "has no password credential (a passkey-only or Google-only account cannot be used from the CLI). " +
        "For the export principal this is a credential problem and never a missing approval — an " +
        "approval that is absent or lapsed fails later, at /api/support/access, and says so",
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

interface Envelope {
  wrappedDEK: string;
  ephemeralPublicKeyJwk: JsonWebKey;
}

interface VaultTarget {
  /** The RECORD's owner — the session's own account on the owner path, someone else's on a granted one. */
  accountId: string;
  vaultId: string;
  r2Key: string;
  envelope: Envelope;
  rotationPending: boolean;
}

/**
 * Unwraps this principal's account key, then the DEK out of whichever envelope it was handed, then
 * decrypts the blob. One copy: the owner path and the granted path differ only in where the envelope and
 * the blob id came from, and two copies of a decryption chain drift.
 */
async function openTarget(session: Session, target: VaultTarget): Promise<OpenVault> {
  const blobId = vaultIdFromR2Key(target.r2Key);
  if (!blobId) throw new Error(`cannot address the vault: r2Key ${target.r2Key} is not a vault blob`);

  const kek = await deriveKekFromPassword(session.password, hexToBytes(session.kdfParams.salt));
  let dek: CryptoKey;
  try {
    const privateKey = await unwrapPrivateKey(b64ToBytes(session.wrappedPrivateKey), kek);
    dek = await unwrapDEKWithPrivateKey(
      b64ToBytes(target.envelope.wrappedDEK),
      target.envelope.ephemeralPublicKeyJwk,
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

  return { vault, dek, accountId: target.accountId, vaultId: target.vaultId, blobId, rotationPending: target.rotationPending };
}

/** Opens the record the signed-in account owns. */
export async function openVault(session: Session): Promise<OpenVault> {
  if (!session.vaultId || !session.r2Key || !session.ownerEnvelope) {
    throw new Error(`${session.email} has no vault to export (the account exists but holds no record)`);
  }
  return openTarget(session, {
    accountId: session.accountId,
    vaultId: session.vaultId,
    r2Key: session.r2Key,
    envelope: session.ownerEnvelope,
    rotationPending: session.rotationPending,
  });
}

export interface GrantedOwner {
  ownerAccountId: string;
  /** ISO, or null for a grant with no expiry. */
  expiresAt: string | null;
}

/**
 * The patients whose approval is LIVE — /api/support/owners drops a revoked link and one whose window
 * has elapsed, which is what makes this list safe to drive `openGrantedVault` from (see its header).
 *
 * `displayName` is dropped here rather than downstream: the common caller is an agent, and a name in a
 * transcript is a second copy of the record. Deliberately unaudited on the server, and its own header
 * says why: every grant in it already has a `support_access_granted` row on the patient's own screen.
 */
export async function listGrantedOwners(session: Session): Promise<GrantedOwner[]> {
  const res = await authedFetch(session, "/api/support/owners");
  if (!res.ok) throw new Error(`cannot list approved records (${res.status} from /api/support/owners)`);
  const { owners } = (await res.json()) as { owners: { ownerAccountId: string; expiresAt?: string | null }[] };
  return owners.map((o) => ({ ownerAccountId: o.ownerAccountId, expiresAt: o.expiresAt ?? null }));
}

/**
 * Ask a patient for access. Creates a PENDING link with no envelope, so nothing is readable until that
 * patient approves from their own unlocked session.
 *
 * `status: "active"` in the reply is NOT proof of a live grant: the route hands back any existing
 * non-revoked link unchanged, and a link whose window has elapsed is still `active`. record-export.ts
 * says what to do about that; here it is only reported.
 */
export async function requestAccess(session: Session, ownerEmail: string): Promise<{ linkId: string; status: string }> {
  const res = await authedFetch(session, "/api/support/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerEmail }),
  });
  if (!res.ok) throw new Error(`cannot ask ${ownerEmail} for access (${res.status} from /api/support/request)`);
  const { linkId, status } = (await res.json()) as { linkId: string; status: string };
  return { linkId, status };
}

/**
 * The audited entry point. POST /api/support/access writes `support_access_opened` with the patient's
 * consent reference before handing over the envelope, so every read this CLI performs is on the record
 * owner's own access screen.
 *
 * NEVER CALL THIS FOR A GRANT THAT IS NOT LIVE. An elapsed-but-`active` link reaches `checkBreakGlass`,
 * whose `onExpire` deletes the envelope AND sets `rotation_pending` — correct, but it forces that
 * patient's whole vault to be re-keyed at their next sign-in for no reason. Callers therefore pass only
 * an `ownerAccountId` that `listGrantedOwners` returned, which the route has already filtered to live
 * grants; tests/unit/support-export.test.ts pins that nothing else is ever opened.
 */
export async function openGrantedVault(session: Session, ownerAccountId: string): Promise<OpenVault> {
  const res = await authedFetch(session, "/api/support/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerAccountId }),
  });
  if (res.status === 403) {
    throw new Error(
      `${ownerAccountId} has no live approval for ${session.email} — ask them to approve it in their ` +
        "Access panel (see --request), and note that an entry left over from a previous window must be " +
        "revoked there first",
    );
  }
  if (!res.ok) throw new Error(`cannot open ${ownerAccountId}'s record (${res.status} from /api/support/access)`);
  // `displayName` and `email` come back in this body and are deliberately not carried out of it.
  const data = (await res.json()) as { ownerAccountId: string; vaultId: string; r2Key: string; envelope: Envelope };
  return openTarget(session, {
    accountId: data.ownerAccountId,
    vaultId: data.vaultId,
    r2Key: data.r2Key,
    envelope: data.envelope,
    // Not in this response, and it is the owner's signal anyway: their next sign-in is what re-keys.
    rotationPending: false,
  });
}

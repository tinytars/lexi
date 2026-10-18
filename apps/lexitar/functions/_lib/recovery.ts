// W73 Phase D — provider-issued recovery grants: issue, redeem, and the rules that make a short code
// safe. One module rather than logic spread across two routes, for the same reason capabilities.ts is
// one table: the policy has to be readable in one sitting to be reviewable at all.
//
// The shape, in one paragraph. A clinician who already holds the patient's DEK re-wraps it under
// PBKDF2 of a fresh one-time code and READS IT to the patient. The patient enters
// it, unwraps the DEK in their browser, generates a NEW account keypair, and uploads the re-wrapped
// key plus a new envelope. The server stores blobs it cannot open, counts attempts, and swaps
// everything atomically. It never sees the code, the DEK, or the password.

import type { D1Database, D1PreparedStatement } from "./identity-types";
import { revokeSessions } from "./identity-accounts";
import { addIdentity, putCredential, putPublicKey } from "./identity-credentials";
import { listVaultsForOwner, setRotationPending } from "./identity-vault";
import { insertAccessEvent } from "./identity-audit";
import { sha256Base64Url, timingSafeEqualStr } from "./verifier";

/** 1 hour. A grant exists to be used during the phone call that created it, not afterwards. */
export const GRANT_TTL_MS = 60 * 60 * 1000;
/** Apple's HSM destroys the escrow record after ten guesses; five is the same idea, applied online. */
export const MAX_ATTEMPTS = 5;

export interface GrantRow {
  id: string;
  accountId: string;
  wrappedDek: Uint8Array | null;
  kdfParams: { salt: string; iterations: number };
  codeVerifierSha256: string;
  issuedBy: string;
  issuedAt: string;
  expiresAt: string;
  attempts: number;
  consumedAt: string | null;
}

interface Row {
  id: string; account_id: string; wrapped_dek: ArrayBuffer | Uint8Array | null; kdf_params: string;
  code_verifier_sha256: string; issued_by: string; issued_at: string; expires_at: string;
  attempts: number; consumed_at: string | null;
}

const map = (r: Row): GrantRow => ({
  id: r.id,
  accountId: r.account_id,
  wrappedDek: r.wrapped_dek ? new Uint8Array(r.wrapped_dek as ArrayBuffer) : null,
  kdfParams: JSON.parse(r.kdf_params),
  codeVerifierSha256: r.code_verifier_sha256,
  issuedBy: r.issued_by,
  issuedAt: r.issued_at,
  expiresAt: r.expires_at,
  attempts: r.attempts,
  consumedAt: r.consumed_at,
});

/**
 * Issues a grant, replacing any live one for the same account.
 *
 * Replacing rather than refusing: a clinician re-issuing almost always means the first code went astray
 * (misheard, mistyped, the call dropped), and refusing would leave them stuck behind a code nobody has.
 * The old blob is destroyed in the same batch, so exactly one is ever openable — which is what the
 * partial unique index enforces at the schema level.
 */
export async function issueGrant(
  db: D1Database,
  g: {
    accountId: string;
    issuedBy: string;
    wrappedDek: Uint8Array;
    kdfParams: { salt: string; iterations: number };
    codeAuthHash: string;
  },
  now: Date = new Date(),
): Promise<GrantRow> {
  const id = crypto.randomUUID();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS).toISOString();
  await db.batch([
    db.prepare("UPDATE recovery_grants SET consumed_at = ?, wrapped_dek = NULL WHERE account_id = ? AND consumed_at IS NULL")
      .bind(issuedAt, g.accountId),
    db.prepare(
      "INSERT INTO recovery_grants (id, account_id, wrapped_dek, kdf_params, code_verifier_sha256, issued_by, issued_at, expires_at, attempts, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)",
    ).bind(id, g.accountId, g.wrappedDek, JSON.stringify(g.kdfParams), await sha256Base64Url(g.codeAuthHash), g.issuedBy, issuedAt, expiresAt),
  ]);
  return (await getLiveGrant(db, g.accountId))!;
}

export async function getLiveGrant(db: D1Database, accountId: string): Promise<GrantRow | null> {
  const row = await db
    .prepare("SELECT * FROM recovery_grants WHERE account_id = ? AND consumed_at IS NULL")
    .bind(accountId)
    .first<Row>();
  return row ? map(row) : null;
}

export type RedeemCheck =
  | { ok: true; grant: GrantRow }
  | { ok: false; errorCode: "no_grant" | "expired" | "too_many_attempts" | "invalid_code" };

/**
 * Checks a redemption attempt and consumes an attempt.
 *
 * Returns the SAME `invalid_code` for a wrong code and for a code on a grant that never existed: the
 * caller is unauthenticated, so distinguishing them would say whether a clinician has issued a grant
 * for a given address — a fact worth hiding, and the same reasoning as decoy-salt.ts.
 *
 * Every rejection path still increments, including a wrong code on an already-doomed grant, so the
 * counter cannot be reset by feeding it garbage.
 */
export async function checkRedemption(
  db: D1Database,
  accountId: string,
  codeAuthHash: string,
  now: Date = new Date(),
): Promise<RedeemCheck> {
  const grant = await getLiveGrant(db, accountId);
  if (!grant || !grant.wrappedDek) return { ok: false, errorCode: "no_grant" };

  if (new Date(grant.expiresAt).getTime() <= now.getTime()) {
    // Expiring destroys the blob rather than merely refusing to serve it. A blob left behind is an
    // offline target that no attempt counter can protect — see migrations/0009.
    await expireGrant(db, grant.id, now);
    return { ok: false, errorCode: "expired" };
  }
  // W75 — claim an attempt slot in ONE statement, and let the row decide. This used to read
  // `grant.attempts`, compare it to MAX_ATTEMPTS, and increment in a separate UPDATE: three
  // statements against a counter that is the only thing standing between a five-character code and
  // the DEK it wraps. Concurrent redemptions all read the same count, all passed the comparison, and
  // all incremented — so "five attempts" meant five ROUNDS of unlimited width, online, against key
  // material. The conditional UPDATE is the idiom already used correctly by `expireGrant` below.
  //
  // RETURNING rather than a rows-changed count: it says both THAT the slot was claimed and WHICH
  // attempt this is, which the last-attempt burn below needs and a stale read cannot supply.
  const claimed = await db
    .prepare("UPDATE recovery_grants SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND attempts < ? RETURNING attempts")
    .bind(grant.id, MAX_ATTEMPTS)
    .first<{ attempts: number }>();
  if (!claimed) {
    // Either the cap was reached while this request was in flight, or the grant was consumed under
    // us. Both mean no attempt remains; `expireGrant` is a no-op on an already-consumed row.
    await expireGrant(db, grant.id, now);
    return { ok: false, errorCode: "too_many_attempts" };
  }

  if (!timingSafeEqualStr(await sha256Base64Url(codeAuthHash), grant.codeVerifierSha256)) {
    // The LAST allowed attempt failing burns the grant immediately rather than leaving a spent blob
    // sitting there until someone else's request happens to notice.
    if (claimed.attempts >= MAX_ATTEMPTS) await expireGrant(db, grant.id, now);
    return { ok: false, errorCode: "invalid_code" };
  }
  return { ok: true, grant };
}

export async function expireGrant(db: D1Database, id: string, now: Date = new Date()): Promise<void> {
  await db
    .prepare("UPDATE recovery_grants SET consumed_at = ?, wrapped_dek = NULL WHERE id = ? AND consumed_at IS NULL")
    .bind(now.toISOString(), id)
    .run();
}

export interface NewIdentity {
  publicKeyJwk: unknown;
  wrappedPrivateKey: Uint8Array;
  kdfParams: { salt: string; iterations: number };
  authHash: string;
  /** The DEK re-wrapped to the NEW public key, so the record opens under the new credential. */
  envelope: { wrappedDEK: Uint8Array; ephemeralPublicKeyJwk: unknown };
}

/**
 * Swaps the account onto a new keypair, in one batch.
 *
 * WHY EVERY OTHER CREDENTIAL IS DELETED, unlike the recovery-code path in `auth/recovery/login.ts`:
 * there the same private key is re-wrapped under a new password, so the passkey/Google/recovery rows
 * still wrap a key that works. Here the keypair itself is replaced, so those rows wrap a key that no
 * envelope references any more. Leaving them would be worse than useless — `auth/recovery/login.ts`
 * mints a full session on an authHash compare BEFORE any key is used, so a stale recovery credential
 * would still hand out a session for an account it can no longer open.
 *
 * One `batch()` because D1 runs a batch as an implicit transaction. A half-applied swap — public key
 * replaced, envelope not — is a permanently unopenable vault with no error at the time it happens.
 */
export async function activateStatements(db: D1Database, accountId: string, vaultId: string | null, id: NewIdentity, grantId: string, now: Date): Promise<D1PreparedStatement[]> {
  const at = now.toISOString();
  // authHashSha256 has to land in kdf_params here too — login.ts:88-93 and signup.ts:105 both store it
  // this way, and password/login.ts reads it back to check a follow-up sign-in. Without it, redemption
  // still mints a valid session (the client unwraps the new key locally, no server check involved), so
  // the bug is invisible until the very next independent login.
  const kdfParams = { ...id.kdfParams, authHashSha256: await sha256Base64Url(id.authHash) };
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE recovery_grants SET consumed_at = ?, wrapped_dek = NULL WHERE id = ? AND consumed_at IS NULL").bind(at, grantId),
    db.prepare("INSERT OR REPLACE INTO public_keys (account_id, public_key_jwk, created_at) VALUES (?, ?, ?)")
      .bind(accountId, JSON.stringify(id.publicKeyJwk), at),
    db.prepare("DELETE FROM credentials WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM identities WHERE account_id = ? AND method != 'password'").bind(accountId),
    db.prepare("INSERT OR REPLACE INTO credentials (account_id, method, wrapped_private_key, kdf_params, created_at) VALUES (?, 'password', ?, ?, ?)")
      .bind(accountId, id.wrappedPrivateKey, JSON.stringify(kdfParams), at),
  ];
  if (vaultId) {
    // Only the OWNER envelope is replaced. The DEK itself has not changed, so the org and provider
    // envelopes still wrap a key that is still correct — replacing them would revoke access nobody
    // asked to revoke.
    stmts.push(
      db.prepare("DELETE FROM vault_envelopes WHERE vault_id = ? AND principal_account_id = ?").bind(vaultId, accountId),
      db.prepare("INSERT INTO vault_envelopes (vault_id, principal_account_id, wrapped_dek, ephemeral_public_key_jwk, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(vaultId, accountId, id.envelope.wrappedDEK, JSON.stringify(id.envelope.ephemeralPublicKeyJwk), accountId, at),
    );
  }
  return stmts;
}

/** Runs the swap and the follow-on bookkeeping that cannot live in the batch. */
export async function activateRecovery(
  db: D1Database,
  accountId: string,
  id: NewIdentity,
  grant: GrantRow,
  now: Date = new Date(),
): Promise<{ vaultId: string | null }> {
  // W75 — an account with more than one vault would have had an arbitrary D1 row order decide which
  // one the recovered owner keeps an envelope for; the rest become unopenable. One vault is the only
  // shape this flow can honestly serve, so say so instead of silently picking.
  const vaults = await listVaultsForOwner(db, accountId);
  if (vaults.length > 1) throw new Error(`account ${accountId} has ${vaults.length} vaults; recovery cannot choose one`);
  const vault = vaults[0] ?? null;
  await db.batch(await activateStatements(db, accountId, vault?.vaultId ?? null, id, grant.id, now));

  // Outside the batch on purpose: none of it can leave the account unopenable if it fails, and all of
  // it is safe to have not happened.
  const hasPasswordIdentity = await db
    .prepare("SELECT 1 AS x FROM identities WHERE account_id = ? AND method = 'password'")
    .bind(accountId)
    .first<{ x: number }>();
  if (!hasPasswordIdentity) await addIdentity(db, { accountId, method: "password" });

  await revokeSessions(db, accountId);

  // The DEK was handed to a code that was spoken aloud or emailed. It is still the same DEK every
  // provider envelope wraps, so it is not compromised — but it has been outside the browser's custody
  // in a way it never otherwise is, and rotation is cheap. The machinery already exists (W44 P4c).
  if (vault) await setRotationPending(db, vault.vaultId, true);

  await insertAccessEvent(db, {
    actorAccountId: grant.issuedBy,
    subjectAccountId: accountId,
    vaultId: vault?.vaultId ?? null,
    action: "recovery.grant_redeemed",
    consentRef: grant.id,
    meta: { issuedAt: grant.issuedAt },
  });

  return { vaultId: vault?.vaultId ?? null };
}

// Re-exported so routes take the shared implementations rather than growing their own.
export { putCredential, putPublicKey };

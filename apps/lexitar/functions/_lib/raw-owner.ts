// W73 — who may touch an object under `{store}/raw/…` or `{store}/text/…`.
//
// SECURITY.md gap 1: all five handlers checked `requireSession` and then built an R2 key straight from
// the URL. The path segment is a CLIENT KEY — a patient's own name for one of their clients — which
// exists only inside the encrypted vault, so the server had nothing to compare it against. Any
// signed-up account could read, overwrite or delete another patient's *plaintext* PDFs, and two
// accounts with a client of the same name shared a namespace.
//
// `raw_objects` (migration 0008) is the missing primitive: it records the writing account per key. This
// module turns that into an answer.
//
// WHY OWNERSHIP IS RESOLVED BY PREFIX, NOT BY EXACT KEY. Checking only the exact key would leave the
// namespace squattable — an attacker could PUT `raw/alex/anything-new.pdf`, become its first writer,
// and thereafter own a key inside someone else's folder. Resolving `raw/alex/` as a whole means the
// first writer claims the CLIENT, and everyone else is measured against them.
//
// WHY A PROVIDER STILL PASSES. A clinician drilled into a patient reads that patient's attachments
// through these same routes. Authorisation therefore is "the owner, or someone holding a live envelope
// for the owner's vault" — and `getEnvelope` is what decides the second half, because it already
// refuses a revoked or expired link in the accessor rather than in each route.

import type { D1Database } from "./identity-types";
import { getEnvelope, listVaultsForOwner } from "./identity-vault";
import { storeKey, type StoreEnv } from "./store";
import { normalizeClientId } from "../../src/lib/client-id";

export type RawAccess =
  | { kind: "owner" }
  | { kind: "granted"; ownerAccountId: string }
  | { kind: "unclaimed" }
  | { kind: "denied"; ownerAccountId: string };

/**
 * The account that owns everything belonging to `clientId`, or null when nothing has claimed it yet.
 *
 * One namespace, three shapes: the originals under `raw/{id}/`, their extracted text under
 * `text/{id}/`, and the flat `chat-{id}.enc` blob. They are answered together on purpose — they are
 * the same patient's same client, and letting the three disagree about who owns them is how a gap
 * like this reappears one route at a time.
 */
export async function ownerOfClientNamespace(
  db: D1Database,
  env: StoreEnv,
  clientId: string,
): Promise<string | null> {
  const slug = normalizeClientId(clientId);
  const row = await db
    .prepare("SELECT account_id FROM raw_objects WHERE r2_key LIKE ?1 OR r2_key LIKE ?2 OR r2_key = ?3 LIMIT 1")
    .bind(
      `${storeKey(env, "raw", slug)}/%`,
      `${storeKey(env, "text", slug)}/%`,
      // The chat blob is a FLAT key, not a folder, and it claims the namespace too. Without it a
      // patient who has chatted but never uploaded an attachment owns nothing — so their own chat
      // history would read as unclaimed and 404 on them. Chat is usually the first thing that happens.
      storeKey(env, `chat-${slug}.enc`),
    )
    .first<{ account_id: string }>();
  return row?.account_id ?? null;
}

/**
 * Decides what `accountId` may do with `clientId`'s objects.
 *
 * `unclaimed` is a distinct answer from `denied`, and callers ALLOW it. That is a deliberate, measured
 * trade rather than an oversight:
 *
 *   - Refusing it would close nothing that matters. The vulnerability was cross-tenant access to a
 *     namespace someone OWNS; an unclaimed one has no owner to protect.
 *   - Refusing it would break real people. Ownership recording began 2026-08-25, and the backfill
 *     (`scripts/raw-backfill.ts`) resolves a namespace by decrypting the vault with the org key — which
 *     cannot be done for a patient who REVOKED org recovery. On dev that is one object belonging to one
 *     such patient. Refusing unclaimed reads would take their own attachment away from them as the
 *     price of protecting nobody.
 *   - It shrinks to nothing on its own. The first write to a namespace claims it, so any object that
 *     matters is claimed the next time its owner touches it.
 *
 * The residual is that an authenticated stranger who GUESSES an unclaimed client key can read it. It is
 * recorded in SECURITY.md rather than left implicit, and every route that calls this logs `access` so
 * the residual is countable rather than assumed small (W75 — the claim that they did was previously
 * false; `log(200)` recorded no access kind and no route wrote a `phi_access_events` row).
 *
 * NONE OF THAT ARGUMENT EXTENDS TO DELETE (W75). Every clause above is about a read or a first write:
 * an unclaimed namespace has no owner to protect, and the first WRITE claims it, so the window closes
 * itself. A delete has no such shape — there is no "first deleter", nothing self-heals, and the object
 * destroyed is plaintext PHI with no undo. Callers that destroy must use `mayDestroy`.
 */
/**
 * May this access DESTROY the object? Stricter than the read/write rule on purpose — see the note in
 * rawAccessFor's doc comment. On prod, where no backfill had run, EVERY namespace was unclaimed the
 * moment objects appeared, which made every patient's originals deletable by any signed-up account.
 */
export const mayDestroy = (access: RawAccess): access is { kind: "owner" } | { kind: "granted"; ownerAccountId: string } =>
  access.kind === "owner" || access.kind === "granted";

export async function rawAccessFor(
  db: D1Database,
  env: StoreEnv,
  accountId: string,
  clientId: string,
): Promise<RawAccess> {
  const ownerAccountId = await ownerOfClientNamespace(db, env, clientId);
  if (!ownerAccountId) return { kind: "unclaimed" };
  if (ownerAccountId === accountId) return { kind: "owner" };

  // Access is a live envelope between these two accounts, checked in BOTH directions.
  //
  // The obvious direction is caller-reads-owner's-vault: a clinician drilled into their patient. The
  // reverse direction is not a nicety, it is a correctness fix for who `raw_objects` records as owner.
  //
  // Ownership is FIRST-WRITER-WINS, and the first writer into a patient's namespace is very often not
  // the patient: a clinician drilled in on their behalf uploads a report, and the clinician is recorded
  // as owner. Checking only one direction then denies the PATIENT access to their own files — which is
  // exactly what main's e2e caught, with a provider and a patient disagreeing about who owned `alex`.
  //
  // Widening to both directions grants nothing new: a live provider link already means each side can
  // open the other's relevant vault. It just stops an accident of write ORDER from deciding who is
  // locked out.
  const candidates = [
    ...(await listVaultsForOwner(db, ownerAccountId)).map((v) => ({ vaultId: v.vaultId, principal: accountId })),
    ...(await listVaultsForOwner(db, accountId)).map((v) => ({ vaultId: v.vaultId, principal: ownerAccountId })),
  ];
  for (const c of candidates) {
    if (await getEnvelope(db, c.vaultId, c.principal)) return { kind: "granted", ownerAccountId };
  }
  return { kind: "denied", ownerAccountId };
}

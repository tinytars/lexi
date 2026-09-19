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
import { recordRawObject } from "./identity-audit";
import { listAllKeys, type ObjectBucket } from "./object-bucket";
import { storeKey, type StoreEnv } from "./store";
import { normalizeClientId } from "../../src/lib/client-id";

// `unclaimed` and `orphaned` both mean "no owner row", and they are split because they deserve opposite
// answers. An EMPTY namespace has nothing to protect, and a first write is how a new client is born, so
// it may be claimed. An ORPHANED one holds someone's objects without saying whose (pre-0008 writes, an
// incomplete erasure), so nobody may read, write or delete it — letting the first writer claim it made
// it readable by a guess and squattable by a single PUT (W76). Orphans are resolved deliberately, never
// by whoever arrives first: `scripts/raw-backfill.ts` (org key or `--assign`), `POST /api/raw/claim`
// (proof of a stored file's full hash), and `scripts/orphan-sweep.ts` for what nobody claims.
export type RawAccess =
  | { kind: "owner" }
  | { kind: "granted"; ownerAccountId: string }
  | { kind: "unclaimed" }
  | { kind: "orphaned" }
  | { kind: "denied"; ownerAccountId: string };

export interface NamespaceEnv extends StoreEnv {
  VAULT: Pick<ObjectBucket, "list">;
}

/**
 * The three key shapes one client's namespace occupies: originals under `raw/{id}/`, their extracted
 * text under `text/{id}/`, and the flat `chat-{id}.enc` blob. Every question about a namespace — who
 * owns it, is it empty, what does claiming it cover — is asked of all three together, because letting
 * them disagree is how an ownership gap reappears one route at a time. The chat key is used as a list
 * PREFIX like the other two, which matches exactly that key.
 */
export function namespacePrefixes(env: StoreEnv, clientId: string): string[] {
  const slug = normalizeClientId(clientId);
  return [`${storeKey(env, "raw", slug)}/`, `${storeKey(env, "text", slug)}/`, storeKey(env, `chat-${slug}.enc`)];
}

/** The inverse of namespacePrefixes: which client namespace an object key belongs to, or null if none. */
export function clientIdOfObjectKey(key: string): string | null {
  const m = /^[^/]+\/(?:(?:raw|text)\/([^/]+)\/.+|chat-(.+)\.enc)$/.exec(key);
  return m ? normalizeClientId(m[1] ?? m[2]) : null;
}

/** The account that owns everything belonging to `clientId`, or null when nothing has claimed it yet. */
export async function ownerOfClientNamespace(db: D1Database, env: StoreEnv, clientId: string): Promise<string | null> {
  const [raw, text, chat] = namespacePrefixes(env, clientId);
  const row = await db
    .prepare("SELECT account_id FROM raw_objects WHERE r2_key LIKE ?1 OR r2_key LIKE ?2 OR r2_key = ?3 LIMIT 1")
    .bind(`${raw}%`, `${text}%`, chat)
    .first<{ account_id: string }>();
  return row?.account_id ?? null;
}

async function namespaceIsEmpty(env: NamespaceEnv, clientId: string): Promise<boolean> {
  for (const prefix of namespacePrefixes(env, clientId)) {
    if ((await env.VAULT.list({ prefix, limit: 1 })).objects.length > 0) return false;
  }
  return true;
}

/** Every object in `clientId`'s namespace, attributed to `accountId`. INSERT OR IGNORE, so it never reassigns. */
export async function claimNamespace(db: D1Database, env: NamespaceEnv, clientId: string, accountId: string): Promise<string[]> {
  const keys: string[] = [];
  for (const prefix of namespacePrefixes(env, clientId)) keys.push(...(await listAllKeys(env.VAULT, prefix)));
  for (const key of keys) await recordRawObject(db, key, accountId);
  return keys;
}

/** May this access see the namespace's objects? Only its owner or someone holding a live grant. */
export const mayRead = (access: RawAccess): access is { kind: "owner" } | { kind: "granted"; ownerAccountId: string } =>
  access.kind === "owner" || access.kind === "granted";

/** Destroying is held to the read rule: there is no "first deleter", and plaintext PHI has no undo (W75). */
export const mayDestroy = mayRead;

/** Writing additionally allows an EMPTY namespace, whose first write claims it. Never an orphaned one. */
export const mayWrite = (access: RawAccess): boolean => mayRead(access) || access.kind === "unclaimed";

/** Decides what `accountId` may do with `clientId`'s objects; the routes apply mayRead/mayWrite/mayDestroy. */
export async function rawAccessFor(
  db: D1Database,
  env: NamespaceEnv,
  accountId: string,
  clientId: string,
): Promise<RawAccess> {
  const ownerAccountId = await ownerOfClientNamespace(db, env, clientId);
  if (!ownerAccountId) return (await namespaceIsEmpty(env, clientId)) ? { kind: "unclaimed" } : { kind: "orphaned" };
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

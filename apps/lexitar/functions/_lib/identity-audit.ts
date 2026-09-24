// The two AuditStore members (insertAccessEvent, listAccessEventsForSubject) moved to
// @tinytars/vault's D1AuditStore (Cloudflare-independence milestone — see
// docs/cross-app/10-open-source-info-security.md); re-exported here so every existing
// "./identity-audit" import site is unchanged. CrmEvent + the W72 raw-object functions stay local —
// health-dash-specific concerns that don't belong in a portable security package (see stores.ts's
// own docstring on AuditStore).
import { D1AuditStore } from "@tinytars/vault/adapters/d1";
import type { D1Database, LifecycleStage } from "./identity-types";

export type { AccessEvent } from "@tinytars/vault/stores";

export function insertAccessEvent(db: D1Database, e: Parameters<D1AuditStore["insertAccessEvent"]>[0]) {
  return new D1AuditStore(db).insertAccessEvent(e);
}
export function listAccessEventsForSubject(db: D1Database, subjectAccountId: string) {
  return new D1AuditStore(db).listAccessEventsForSubject(subjectAccountId);
}

export interface CrmEvent {
  id: string;
  accountId: string;
  event: string;
  stageFrom: LifecycleStage | null;
  stageTo: LifecycleStage | null;
  meta: unknown;
  createdAt: string;
  syncedAt: string | null;
}

interface CrmEventRow {
  id: string;
  account_id: string;
  event: string;
  stage_from: LifecycleStage | null;
  stage_to: LifecycleStage | null;
  meta: string;
  created_at: string;
  synced_at: string | null;
}
function mapCrmEvent(r: CrmEventRow): CrmEvent {
  return {
    id: r.id,
    accountId: r.account_id,
    event: r.event,
    stageFrom: r.stage_from,
    stageTo: r.stage_to,
    meta: JSON.parse(r.meta),
    createdAt: r.created_at,
    syncedAt: r.synced_at,
  };
}

export async function insertCrmEvent(
  db: D1Database,
  e: { accountId: string; event: string; stageFrom?: LifecycleStage | null; stageTo?: LifecycleStage | null; meta?: unknown; id?: string }
): Promise<CrmEvent> {
  const id = e.id ?? crypto.randomUUID();
  const stageFrom = e.stageFrom ?? null;
  const stageTo = e.stageTo ?? null;
  const meta = e.meta ?? {};
  const createdAt = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO crm_events (id, account_id, event, stage_from, stage_to, meta, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"
    )
    .bind(id, e.accountId, e.event, stageFrom, stageTo, JSON.stringify(meta), createdAt)
    .run();
  return { id, accountId: e.accountId, event: e.event, stageFrom, stageTo, meta, createdAt, syncedAt: null };
}

export async function listCrmEvents(db: D1Database, accountId: string): Promise<CrmEvent[]> {
  const { results } = await db.prepare("SELECT * FROM crm_events WHERE account_id = ?").bind(accountId).all<CrmEventRow>();
  return results.map(mapCrmEvent);
}

export async function markCrmEventSynced(db: D1Database, id: string, syncedAt?: string): Promise<void> {
  await db.prepare("UPDATE crm_events SET synced_at = ? WHERE id = ?").bind(syncedAt ?? new Date().toISOString(), id).run();
}

// ── W72 raw-object ownership ─────────────────────────────────────────────────
// See migrations/0008_account_erasure.sql for why this table exists at all. Recorded on write; read
// only by the erasure plan today.

export interface RawObjectMeasurement {
  /** Page count, from the browser's pdf.js — a Worker cannot count pages itself. */
  pages?: number;
  bytes?: number;
}

export async function recordRawObject(
  db: D1Database,
  r2Key: string,
  accountId: string,
  meta: RawObjectMeasurement = {},
): Promise<void> {
  // A re-PUT of the same key is idempotent in R2 and must be idempotent here too, and it must NOT
  // reassign ownership: the first writer owns the key, so a later account writing the same path
  // cannot claim someone else's object by overwriting it.
  await db
    .prepare("INSERT OR IGNORE INTO raw_objects (r2_key, account_id, created_at, pages, bytes) VALUES (?, ?, ?, ?, ?)")
    .bind(r2Key, accountId, new Date().toISOString(), meta.pages ?? null, meta.bytes ?? null)
    .run();
  // INSERT OR IGNORE above is a no-op for a key that already exists, which is exactly the row a
  // backfill or a re-upload needs to measure.
  if (meta.pages !== undefined) await fillRawPageCount(db, r2Key, meta.pages, meta.bytes);
}

/**
 * Record a page count for a key that already has an ownership row, filling a MISSING count only.
 *
 * The `pages IS NULL` guard is the whole point: a stored count is what the corpus ceiling is checked
 * against, so letting a later caller lower it would let a client talk its way past the limit one
 * request at a time.
 */
export async function fillRawPageCount(db: D1Database, r2Key: string, pages: number, bytes?: number): Promise<void> {
  await db
    .prepare("UPDATE raw_objects SET pages = ?, bytes = COALESCE(?, bytes) WHERE r2_key = ? AND pages IS NULL")
    .bind(pages, bytes ?? null, r2Key)
    .run();
}

export interface RawPdfRow {
  r2_key: string;
  pages: number | null;
  bytes: number | null;
}

/**
 * Every raw PDF recorded under one client namespace, ordered by key.
 *
 * The ORDER is load-bearing, not cosmetic: the corpus turn built from these rows is a prompt-cache
 * prefix, and a prefix that reorders between two requests is a different prefix. D1 sorts here so
 * the assembler never depends on R2's listing order.
 */
export async function listRawPdfsUnder(db: D1Database, keyPrefix: string): Promise<RawPdfRow[]> {
  const { results } = await db
    .prepare("SELECT r2_key, pages, bytes FROM raw_objects WHERE r2_key LIKE ? AND lower(r2_key) LIKE '%.pdf' ORDER BY r2_key")
    .bind(`${keyPrefix}%`)
    .all<RawPdfRow>();
  return results;
}

/**
 * Every raw object recorded under one client namespace, ordered by key.
 *
 * D1 rather than an R2 listing, and not only the PDFs, because this is the set the browser's sealing
 * sweep has to close: the corpus reads these same rows, so an object the vault holds no content key
 * for refuses that patient's every question even when nothing in the record still points at it.
 */
export async function listRawObjectsUnder(db: D1Database, keyPrefix: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT r2_key FROM raw_objects WHERE r2_key LIKE ? ORDER BY r2_key")
    .bind(`${keyPrefix}%`)
    .all<{ r2_key: string }>();
  return results.map((r) => r.r2_key);
}

export async function listRawObjectsForAccount(db: D1Database, accountId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT r2_key FROM raw_objects WHERE account_id = ? ORDER BY r2_key")
    .bind(accountId)
    .all<{ r2_key: string }>();
  return results.map((r) => r.r2_key);
}

export async function deleteRawObjectsForAccount(db: D1Database, accountId: string): Promise<void> {
  await db.prepare("DELETE FROM raw_objects WHERE account_id = ?").bind(accountId).run();
}

/** Every raw/text key that HAS an ownership row, regardless of owner — see erasure.ts's `unattributable`. */
export async function listAllRawObjectKeys(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT r2_key FROM raw_objects").all<{ r2_key: string }>();
  return new Set(results.map((r) => r.r2_key));
}

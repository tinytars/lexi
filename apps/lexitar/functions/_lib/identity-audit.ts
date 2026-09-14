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

export async function recordRawObject(db: D1Database, r2Key: string, accountId: string): Promise<void> {
  // A re-PUT of the same key is idempotent in R2 and must be idempotent here too, and it must NOT
  // reassign ownership: the first writer owns the key, so a later account writing the same path
  // cannot claim someone else's object by overwriting it.
  await db
    .prepare("INSERT OR IGNORE INTO raw_objects (r2_key, account_id, created_at) VALUES (?, ?, ?)")
    .bind(r2Key, accountId, new Date().toISOString())
    .run();
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

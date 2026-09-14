// Moved to @tinytars/vault's D1AccountStore (Cloudflare-independence milestone — see
// docs/cross-app/10-open-source-info-security.md). Re-exported here as the original function
// names so every existing "./identity-accounts" import site is unchanged.
import { D1AccountStore } from "@tinytars/vault/adapters/d1";
import type { D1Database } from "@tinytars/vault/adapters/d1";

export type { Account } from "@tinytars/vault/stores";

export function createAccount(db: D1Database, a: Parameters<D1AccountStore["create"]>[0]) {
  return new D1AccountStore(db).create(a);
}
export function getAccount(db: D1Database, id: string) {
  return new D1AccountStore(db).get(id);
}
export function getAccountByEmail(db: D1Database, email: string) {
  return new D1AccountStore(db).getByEmail(email);
}
export function sessionsValidFrom(db: D1Database, accountId: string) {
  return new D1AccountStore(db).sessionsValidFrom(accountId);
}
export function revokeSessions(db: D1Database, accountId: string) {
  return new D1AccountStore(db).revokeSessions(accountId);
}
export function setEmailConfirmed(db: D1Database, id: string, confirmed: boolean) {
  return new D1AccountStore(db).setEmailConfirmed(id, confirmed);
}
export function setLifecycleStage(db: D1Database, id: string, stage: Parameters<D1AccountStore["setLifecycleStage"]>[1]) {
  return new D1AccountStore(db).setLifecycleStage(id, stage);
}
export function updateAccountProfile(db: D1Database, id: string, updates: Parameters<D1AccountStore["updateProfile"]>[1]) {
  return new D1AccountStore(db).updateProfile(id, updates);
}
export function tombstoneAccount(db: D1Database, accountId: string, at: string) {
  return new D1AccountStore(db).tombstone(accountId, at);
}
export function markEmailChanged(db: D1Database, accountId: string, at: string) {
  return new D1AccountStore(db).markEmailChanged(accountId, at);
}

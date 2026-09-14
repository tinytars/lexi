// Moved to @tinytars/vault's D1CredentialStore (Cloudflare-independence milestone — see
// docs/cross-app/10-open-source-info-security.md). Re-exported here as the original function
// names so every existing "./identity-credentials" import site is unchanged.
import { D1CredentialStore } from "@tinytars/vault/adapters/d1";
import type { D1Database } from "@tinytars/vault/adapters/d1";

export type { Identity, Credential, PublicKey } from "@tinytars/vault/stores";

export function addIdentity(db: D1Database, i: Parameters<D1CredentialStore["addIdentity"]>[0]) {
  return new D1CredentialStore(db).addIdentity(i);
}
export function getIdentityByProviderSubject(
  db: D1Database,
  method: Parameters<D1CredentialStore["getIdentityByProviderSubject"]>[0],
  subject: string
) {
  return new D1CredentialStore(db).getIdentityByProviderSubject(method, subject);
}
export function getIdentityByCredentialId(db: D1Database, credentialId: string) {
  return new D1CredentialStore(db).getIdentityByCredentialId(credentialId);
}
export function listIdentities(db: D1Database, accountId: string) {
  return new D1CredentialStore(db).listIdentities(accountId);
}
export function deleteIdentity(db: D1Database, accountId: string, method: Parameters<D1CredentialStore["deleteIdentity"]>[1]) {
  return new D1CredentialStore(db).deleteIdentity(accountId, method);
}
export function putCredential(db: D1Database, c: Parameters<D1CredentialStore["putCredential"]>[0]) {
  return new D1CredentialStore(db).putCredential(c);
}
export function getCredential(db: D1Database, accountId: string, method: Parameters<D1CredentialStore["getCredential"]>[1]) {
  return new D1CredentialStore(db).getCredential(accountId, method);
}
export function listCredentials(db: D1Database, accountId: string) {
  return new D1CredentialStore(db).listCredentials(accountId);
}
export function deleteCredential(db: D1Database, accountId: string, method: Parameters<D1CredentialStore["deleteCredential"]>[1]) {
  return new D1CredentialStore(db).deleteCredential(accountId, method);
}
export function updatePasskeyCounter(db: D1Database, accountId: string, counter: number) {
  return new D1CredentialStore(db).updatePasskeyCounter(accountId, counter);
}
export function putPublicKey(db: D1Database, p: Parameters<D1CredentialStore["putPublicKey"]>[0]) {
  return new D1CredentialStore(db).putPublicKey(p);
}
export function getPublicKey(db: D1Database, accountId: string) {
  return new D1CredentialStore(db).getPublicKey(accountId);
}

// Moved to @tinytars/vault's D1ProviderLinkStore (Cloudflare-independence milestone — see
// docs/cross-app/10-open-source-info-security.md). Re-exported here as the original function
// names so every existing "./identity-providers" import site is unchanged.
import { D1ProviderLinkStore } from "@tinytars/vault/adapters/d1";
import type { D1Database } from "@tinytars/vault/adapters/d1";

export type { ProviderLink } from "@tinytars/vault/stores";

export function createProviderLink(db: D1Database, l: Parameters<D1ProviderLinkStore["create"]>[0]) {
  return new D1ProviderLinkStore(db).create(l);
}
export function updateProviderLinkStatus(db: D1Database, id: string, status: Parameters<D1ProviderLinkStore["updateStatus"]>[1]) {
  return new D1ProviderLinkStore(db).updateStatus(id, status);
}
// One consent decision written as one statement: status, time-box and consent ref together. The store
// method is named `grantSupport` for the break-glass case it was written for, but its SQL asks nothing
// about role — the support-only check lives in `grantBreakGlass`, a layer up — and a clinician grant
// needs exactly the same three columns. Named for what it does, because the alternative is a clinician
// renewal calling something named for support. (It was `grantSupportLink` and had no call sites.)
export function setLinkGrant(db: D1Database, id: string, opts: Parameters<D1ProviderLinkStore["grantSupport"]>[1]) {
  return new D1ProviderLinkStore(db).grantSupport(id, opts);
}
export function getProviderLink(db: D1Database, id: string) {
  return new D1ProviderLinkStore(db).get(id);
}
export function listProvidersForPatient(db: D1Database, patientAccountId: string) {
  return new D1ProviderLinkStore(db).listForOwner(patientAccountId);
}
export function listPatientsForProvider(db: D1Database, providerAccountId: string) {
  return new D1ProviderLinkStore(db).listForProvider(providerAccountId);
}
export function getActiveProviderLink(db: D1Database, patientAccountId: string, providerAccountId: string) {
  return new D1ProviderLinkStore(db).getActive(patientAccountId, providerAccountId);
}

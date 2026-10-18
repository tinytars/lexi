// D1 structural types moved to @tinytars/vault's adapters/d1 (Cloudflare-independence milestone —
// see docs/cross-app/10-open-source-info-security.md). Re-exported here so every existing
// "./identity-types" import site is unchanged.
export type { D1Database, D1PreparedStatement } from "@tinytars/vault/adapters/d1";

// Canonical definitions moved to @tinytars/vault's stores.ts (the storage-agnostic contracts);
// re-exported here so every existing identity-*.ts import site is unchanged.
export type { LifecycleStage, AuthMethod, ProviderKind, LinkStatus, UnitSystem } from "@tinytars/vault/stores";

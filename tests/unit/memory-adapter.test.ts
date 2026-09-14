import {
  MemoryAccountStore,
  MemoryCredentialStore,
  MemoryEnvelopeStore,
  MemoryProviderLinkStore,
  MemoryAuditStore,
} from "@tinytars/vault/adapters/memory";
import {
  runAccountStoreConformance,
  runCredentialStoreConformance,
  runEnvelopeStoreConformance,
  runProviderLinkStoreConformance,
  runAuditStoreConformance,
} from "@tinytars/vault/adapters/conformance";

// Runs the exact same contract suite that tests/unit/d1-identity-store.test.ts's D1 adapter satisfies
// (via Miniflare) against these plain in-memory stores instead. Two structurally unrelated adapters
// passing identical assertions is the actual evidence @tars/security's "storage-agnostic" claim holds,
// not just an assertion made by interface shape (see docs/cross-app/10-open-source-info-security.md).

runAccountStoreConformance("memory", () => new MemoryAccountStore());
runCredentialStoreConformance("memory", () => new MemoryCredentialStore());
runEnvelopeStoreConformance("memory", () => new MemoryEnvelopeStore());
runProviderLinkStoreConformance("memory", () => new MemoryProviderLinkStore());
runAuditStoreConformance("memory", () => new MemoryAuditStore());

import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import {
  D1AccountStore,
  D1CredentialStore,
  D1EnvelopeStore,
  D1ProviderLinkStore,
  D1AuditStore,
} from "@tinytars/vault/adapters/d1";
import { resolveEnvelopeAccess } from "@tinytars/vault/envelope-access";
import { ORG_ACCOUNT_ID } from "../../functions/_lib/org";
import {
  runAccountStoreConformance,
  runCredentialStoreConformance,
  runEnvelopeStoreConformance,
  runProviderLinkStoreConformance,
  runAuditStoreConformance,
} from "@tinytars/vault/adapters/conformance";

// Contract-conformance for the D1 adapters in @tinytars/vault/adapters/d1: each store class
// is a one-line wrapper over the identity-*.ts free functions, so this exercises the wiring itself
// (right function, right argument order) rather than re-testing behavior already covered by the
// identity-*.ts and route-level unit tests.

let mf: Miniflare;
let db: any;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-d1-store" } });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
});
afterAll(async () => {
  await mf.dispose();
});

// The shared contract suite (@tinytars/vault/adapters/conformance) run against the SAME D1
// database as above. tests/unit/memory-adapter.test.ts runs the identical suite against the memory
// adapter — a pass on both is the actual proof "storage-agnostic" holds, not just interface shape.
//
// Unlike the memory adapter (a fresh Map per factory() call), this D1 database persists across the
// whole file. The conformance suites reuse fixed ids (e.g. "vault-1") across their own `it` blocks,
// so the factory wipes every identity table before each call — the D1 equivalent of "fresh store".
const RESET_TABLES = [
  "phi_access_events",
  "provider_links",
  "vault_envelopes",
  "vaults",
  "credentials",
  "public_keys",
  "identities",
  "accounts",
];
async function resetD1(): Promise<void> {
  for (const table of RESET_TABLES) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}

// The Credential/Envelope/ProviderLink/Audit conformance suites reference accounts by fixed id
// ("acct-1", "p1"/"p2"/"d1"/"d2") without going through AccountStore themselves — fine for the memory
// adapter, which has no cross-store referential integrity, but D1's schema FKs identities/credentials/
// vaults/provider_links/phi_access_events to accounts(id). Seed the fixed ids each suite actually uses
// so their D1 inserts satisfy the same constraint a real caller would. AccountStore's own suite creates
// these ids itself (that's what it's testing), so it resets without seeding to avoid a duplicate-key
// collision.
const FIXTURE_ACCOUNT_IDS = ["acct-1", "acct-2", "p1", "p2", "d1", "d2"];
async function resetD1WithFixtureAccounts(): Promise<void> {
  await resetD1();
  for (const id of FIXTURE_ACCOUNT_IDS) {
    await db
      .prepare("INSERT INTO accounts (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind(id, id, new Date().toISOString())
      .run();
  }
}

runAccountStoreConformance("D1", async () => { await resetD1(); return new D1AccountStore(db); });
runCredentialStoreConformance("D1", async () => { await resetD1WithFixtureAccounts(); return new D1CredentialStore(db); });
runEnvelopeStoreConformance("D1", async () => { await resetD1WithFixtureAccounts(); return new D1EnvelopeStore(db); });
runProviderLinkStoreConformance("D1", async () => { await resetD1WithFixtureAccounts(); return new D1ProviderLinkStore(db); });
runAuditStoreConformance("D1", async () => { await resetD1WithFixtureAccounts(); return new D1AuditStore(db); });

describe("D1AccountStore", () => {
  it("creates, reads, and updates an account through the store interface", async () => {
    const store = new D1AccountStore(db);
    const account = await store.create({ id: crypto.randomUUID(), displayName: "Ada", email: "ada@example.com" });
    expect(await store.get(account.id)).toEqual(account);
    expect(await store.getByEmail("ada@example.com")).toEqual(account);

    await store.setEmailConfirmed(account.id, true);
    await store.setLifecycleStage(account.id, "paying");
    await store.updateProfile(account.id, { displayName: "Ada Lovelace" });
    const updated = await store.get(account.id);
    expect(updated?.emailConfirmed).toBe(true);
    expect(updated?.lifecycleStage).toBe("paying");
    expect(updated?.displayName).toBe("Ada Lovelace");

    expect(await store.sessionsValidFrom(account.id)).toBeNull();
    await store.revokeSessions(account.id);
    expect(await store.sessionsValidFrom(account.id)).not.toBeNull();

    await store.tombstone(account.id, new Date().toISOString());
    expect((await store.get(account.id))?.lifecycleStage).toBe("churned");
  });
});

describe("D1CredentialStore", () => {
  it("wires identities, credentials, and public keys through the store interface", async () => {
    const accounts = new D1AccountStore(db);
    const store = new D1CredentialStore(db);
    const account = await accounts.create({ id: crypto.randomUUID(), displayName: "Bob" });

    const identity = await store.addIdentity({ accountId: account.id, method: "password" });
    expect(await store.getIdentityByCredentialId(identity.id)).toBeNull();
    expect(await store.listIdentities(account.id)).toEqual([identity]);

    await store.putCredential({ accountId: account.id, method: "password", wrappedPrivateKey: new Uint8Array([1, 2, 3]), kdfParams: { n: 1 } });
    const cred = await store.getCredential(account.id, "password");
    expect(cred?.wrappedPrivateKey).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.listCredentials(account.id)).toEqual([{ method: "password", createdAt: cred!.createdAt }]);

    await store.putPublicKey({ accountId: account.id, publicKeyJwk: { kty: "EC" } });
    expect((await store.getPublicKey(account.id))?.publicKeyJwk).toEqual({ kty: "EC" });

    await store.deleteCredential(account.id, "password");
    expect(await store.getCredential(account.id, "password")).toBeNull();
    await store.deleteIdentity(account.id, "password");
    expect(await store.listIdentities(account.id)).toEqual([]);
  });
});

describe("D1EnvelopeStore + resolveEnvelopeAccess", () => {
  it("composes vault/envelope storage with provider-link policy", async () => {
    const accounts = new D1AccountStore(db);
    const envelopes = new D1EnvelopeStore(db);
    const links = new D1ProviderLinkStore(db);

    const owner = await accounts.create({ id: crypto.randomUUID(), displayName: "Owner" });
    const provider = await accounts.create({ id: crypto.randomUUID(), displayName: "Provider" });
    const stranger = await accounts.create({ id: crypto.randomUUID(), displayName: "Stranger" });
    // vault_envelopes.principal_account_id FKs to accounts(id) — the org-recovery envelope below needs
    // a real row, same as vault-rotate-function.test.ts's beforeAll.
    if (!(await accounts.get(ORG_ACCOUNT_ID))) {
      await accounts.create({ id: ORG_ACCOUNT_ID, displayName: "Org" });
    }

    const vaultId = crypto.randomUUID();
    await envelopes.createVault({ vaultId, ownerAccountId: owner.id, r2Key: `k/${vaultId}.enc`, hd1Version: 2 });
    await envelopes.putEnvelope({ vaultId, principalAccountId: owner.id, wrappedDek: new Uint8Array([9]), ephemeralPublicKeyJwk: {}, createdBy: owner.id });
    await envelopes.putEnvelope({ vaultId, principalAccountId: ORG_ACCOUNT_ID, wrappedDek: new Uint8Array([9]), ephemeralPublicKeyJwk: {}, createdBy: owner.id });

    // Owner always resolves, with no provider link.
    expect((await resolveEnvelopeAccess(envelopes, links, vaultId, owner.id, ORG_ACCOUNT_ID))?.principalAccountId).toBe(owner.id);

    // A stranger with no active link is refused.
    expect(await resolveEnvelopeAccess(envelopes, links, vaultId, stranger.id, ORG_ACCOUNT_ID)).toBeNull();

    // A provider with an active link — and an envelope of their own — resolves.
    await envelopes.putEnvelope({ vaultId, principalAccountId: provider.id, wrappedDek: new Uint8Array([9]), ephemeralPublicKeyJwk: {}, createdBy: owner.id });
    const link = await links.create({ ownerAccountId: owner.id, providerAccountId: provider.id, role: "primary", status: "active", grantedBy: owner.id });
    expect((await resolveEnvelopeAccess(envelopes, links, vaultId, provider.id, ORG_ACCOUNT_ID))?.principalAccountId).toBe(provider.id);

    // Revoking the link cuts access even though the envelope row still exists.
    await links.updateStatus(link.id, "revoked");
    expect(await resolveEnvelopeAccess(envelopes, links, vaultId, provider.id, ORG_ACCOUNT_ID)).toBeNull();

    // The org-recovery principal resolves until the owner revokes it.
    expect((await resolveEnvelopeAccess(envelopes, links, vaultId, ORG_ACCOUNT_ID, ORG_ACCOUNT_ID))?.principalAccountId).toBe(ORG_ACCOUNT_ID);
    await envelopes.setOrgRecoveryRevoked(vaultId, new Date().toISOString());
    expect(await resolveEnvelopeAccess(envelopes, links, vaultId, ORG_ACCOUNT_ID, ORG_ACCOUNT_ID)).toBeNull();
  });
});

describe("D1AuditStore", () => {
  it("records and lists PHI-access events through the store interface", async () => {
    const accounts = new D1AccountStore(db);
    const store = new D1AuditStore(db);
    const actor = await accounts.create({ id: crypto.randomUUID(), displayName: "Actor" });
    const subject = await accounts.create({ id: crypto.randomUUID(), displayName: "Subject" });

    const event = await store.insertAccessEvent({ actorAccountId: actor.id, subjectAccountId: subject.id, action: "vault.read" });
    expect(await store.listAccessEventsForSubject(subject.id)).toEqual([event]);
  });
});

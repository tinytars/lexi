import { describe, it, expect } from "vitest";
import { supportApproveHandler } from "../../functions/_lib/routes/support-approve";
import { providersApproveSupportHandler } from "../../functions/_lib/routes/providers-approve-support";
import { supportAccessHandler } from "../../functions/_lib/routes/support-access";
import { providersLinkRevokeHandler } from "../../functions/_lib/routes/providers-link-revoke";
import {
  MemoryProviderLinkStore,
  MemoryAuditStore,
  MemoryEnvelopeStore,
} from "@tinytars/vault/adapters/memory";
import type { Account, VaultRow } from "@tinytars/vault/stores";

// Fast portable-handler-level tests for the four break-glass routes: call each PortableHandler
// directly with hand-built Deps (no Miniflare, no Cloudflare Request/env/params shape). This is what
// actually proves pagesHandler's buildDeps wiring in functions/api/**/*.ts is a thin, correct
// passthrough — the Miniflare-level tests (support-access-function.test.ts, providers-manage-
// function.test.ts) already cover the route's full behavior end-to-end through that wrapper.
//
// Store deps are the real memory adapter (@tinytars/vault/adapters/memory), not hand-rolled fakes —
// it's already proven conformant (memory-adapter.test.ts), so using it here is both less code and a
// second demonstration that the portable handlers work against a store with zero Cloudflare in it.

const json = (body: unknown) => JSON.stringify(body);
const post = (body: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: json(body) });
const del = () => new Request("http://x", { method: "DELETE" });
const session = (accountId: string) => async () => ({ accountId });

describe("supportApproveHandler (portable, no Miniflare)", () => {
  it("approves a pending support link and writes an envelope", async () => {
    const links = new MemoryProviderLinkStore();
    const audit = new MemoryAuditStore();
    const envelopes = new MemoryEnvelopeStore();
    const link = await links.create({ ownerAccountId: "patient-1", providerAccountId: "support-1", role: "support", status: "invited", grantedBy: "patient-1" });
    const vault: VaultRow = { vaultId: "vault-1", ownerAccountId: "patient-1", r2Key: "k", hd1Version: 2, rotationPending: false, orgRecoveryRevokedAt: null, rotationStagingR2Key: null };

    const res = await supportApproveHandler(
      post({ linkId: link.id, wrappedDEK: btoa("dek-bytes"), ephemeralPublicKeyJwk: { kty: "EC" } }),
      { requireSession: session("patient-1"), links, audit, envelopes, listVaultsForOwner: async () => [vault] }
    );

    expect(res.status).toBe(200);
    expect((await links.get(link.id))?.status).toBe("active");
    expect(await envelopes.getEnvelopeRow("vault-1", "support-1")).not.toBeNull();
  });

  it("403s when there is no matching pending link", async () => {
    const links = new MemoryProviderLinkStore();
    const res = await supportApproveHandler(
      post({ linkId: "does-not-exist", wrappedDEK: btoa("x"), ephemeralPublicKeyJwk: {} }),
      { requireSession: session("patient-1"), links, audit: new MemoryAuditStore(), envelopes: new MemoryEnvelopeStore(), listVaultsForOwner: async () => [] }
    );
    expect(res.status).toBe(403);
  });
});

describe("providersApproveSupportHandler (portable, no Miniflare)", () => {
  const clinician: Account = { id: "clinician-1", email: null, emailConfirmed: false, displayName: "Dr", lifecycleStage: "active", providerKind: "primary", unitSystem: null, createdAt: new Date().toISOString() };
  const patient: Account = { ...clinician, id: "patient-1", providerKind: null };

  it("approves a pending roster request, metadata-only (no envelope store required)", async () => {
    const links = new MemoryProviderLinkStore();
    const audit = new MemoryAuditStore();
    const link = await links.create({ ownerAccountId: "clinician-1", providerAccountId: "support-1", role: "support", status: "invited", grantedBy: "clinician-1" });

    const res = await providersApproveSupportHandler(
      post({ linkId: link.id }),
      { requireSession: session("clinician-1"), getAccount: async () => clinician, links, audit }
    );

    expect(res.status).toBe(200);
    expect((await links.get(link.id))?.status).toBe("active");
  });

  it("403s a non-provider (patient) account", async () => {
    const res = await providersApproveSupportHandler(
      post({ linkId: "irrelevant" }),
      { requireSession: session("patient-1"), getAccount: async () => patient, links: new MemoryProviderLinkStore(), audit: new MemoryAuditStore() }
    );
    expect(res.status).toBe(403);
  });
});

describe("supportAccessHandler (portable, no Miniflare)", () => {
  const support: Account = { id: "support-1", email: null, emailConfirmed: false, displayName: "Support", lifecycleStage: "active", providerKind: "support", unitSystem: null, createdAt: new Date().toISOString() };

  it("returns the envelope for an active, unexpired support grant and audits the open", async () => {
    const links = new MemoryProviderLinkStore();
    const audit = new MemoryAuditStore();
    const envelopes = new MemoryEnvelopeStore();
    const activeLink = await links.create({ ownerAccountId: "patient-1", providerAccountId: "support-1", role: "support", status: "active", grantedBy: "patient-1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const vault: VaultRow = { vaultId: "vault-1", ownerAccountId: "patient-1", r2Key: "k", hd1Version: 2, rotationPending: false, orgRecoveryRevokedAt: null, rotationStagingR2Key: null };
    const events: unknown[] = [];

    const res = await supportAccessHandler(
      post({ ownerAccountId: "patient-1" }),
      {
        requireSession: session("support-1"),
        getAccount: async () => support,
        listPatientsForProvider: async () => [activeLink],
        listVaultsForOwner: async () => [vault],
        getEnvelope: async () => ({ vaultId: "vault-1", principalAccountId: "support-1", wrappedDek: new Uint8Array([1, 2, 3]), ephemeralPublicKeyJwk: {}, createdBy: "patient-1", createdAt: new Date().toISOString() }),
        insertAccessEvent: async (e) => { events.push(e); return e; },
        links,
        audit,
        envelopes,
      }
    );

    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it("403s with no active support grant for that patient", async () => {
    const res = await supportAccessHandler(
      post({ ownerAccountId: "patient-1" }),
      {
        requireSession: session("support-1"),
        getAccount: async () => support,
        listPatientsForProvider: async () => [],
        listVaultsForOwner: async () => [],
        getEnvelope: async () => null,
        insertAccessEvent: async (e) => e,
        links: new MemoryProviderLinkStore(),
        audit: new MemoryAuditStore(),
        envelopes: new MemoryEnvelopeStore(),
      }
    );
    expect(res.status).toBe(403);
  });
});

describe("providersLinkRevokeHandler (portable, no Miniflare)", () => {
  it("revokes the link and deletes the provider's envelope", async () => {
    const links = new MemoryProviderLinkStore();
    const audit = new MemoryAuditStore();
    const envelopes = new MemoryEnvelopeStore();
    const link = await links.create({ ownerAccountId: "patient-1", providerAccountId: "provider-1", role: "primary", status: "active", grantedBy: "patient-1" });
    const vault: VaultRow = { vaultId: "vault-1", ownerAccountId: "patient-1", r2Key: "k", hd1Version: 2, rotationPending: false, orgRecoveryRevokedAt: null, rotationStagingR2Key: null };
    await envelopes.putEnvelope({ vaultId: "vault-1", principalAccountId: "provider-1", wrappedDek: new Uint8Array([1]), ephemeralPublicKeyJwk: {}, createdBy: "patient-1" });

    const res = await providersLinkRevokeHandler(del(), {
      requireSession: session("patient-1"),
      linkId: link.id,
      getProviderLink: async (id) => links.get(id),
      listVaultsForOwner: async () => [vault],
      links,
      audit,
      envelopes,
    });

    expect(res.status).toBe(200);
    expect((await links.get(link.id))?.status).toBe("revoked");
    expect(await envelopes.getEnvelopeRow("vault-1", "provider-1")).toBeNull();
  });

  it("403s a caller who is neither the patient nor the provider on the link", async () => {
    const links = new MemoryProviderLinkStore();
    const link = await links.create({ ownerAccountId: "patient-1", providerAccountId: "provider-1", role: "primary", status: "active", grantedBy: "patient-1" });

    const res = await providersLinkRevokeHandler(del(), {
      requireSession: session("stranger-1"),
      linkId: link.id,
      getProviderLink: async (id) => links.get(id),
      listVaultsForOwner: async () => [],
      links,
      audit: new MemoryAuditStore(),
      envelopes: new MemoryEnvelopeStore(),
    });

    expect(res.status).toBe(403);
  });
});

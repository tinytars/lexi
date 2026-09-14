import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import type { LinkStatus } from "../../functions/_lib/identity-types";
import { createAccount, getAccount, getAccountByEmail, setEmailConfirmed, setLifecycleStage, updateAccountProfile } from "../../functions/_lib/identity-accounts";
import { addIdentity, getCredential, getIdentityByCredentialId, getIdentityByProviderSubject, getPublicKey, listIdentities, putCredential, putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, deleteEnvelope, getEnvelope, getEnvelopeRow, getVault, listEnvelopesForPrincipal, listEnvelopesForVault, listVaultsForOwner, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink, getProviderLink, listPatientsForProvider, listProvidersForPatient, updateProviderLinkStatus } from "../../functions/_lib/identity-providers";
import { insertCrmEvent, listCrmEvents, markCrmEventSynced } from "../../functions/_lib/identity-audit";

let mf: Miniflare;
let db: any; // D1Database

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-identity" },
  });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
});

afterAll(async () => {
  await mf.dispose();
});

describe("identity accessors", () => {
  it("creates and reads an account by id and email", async () => {
    const created = await createAccount(db, { id: "acc-1", displayName: "Pablo", email: "pablo@example.com" });
    expect(created.emailConfirmed).toBe(false);
    expect(created.lifecycleStage).toBe("active");

    const byId = await getAccount(db, "acc-1");
    expect(byId).toEqual(created);

    const byEmail = await getAccountByEmail(db, "pablo@example.com");
    expect(byEmail).toEqual(created);

    expect(await getAccount(db, "acc-missing")).toBeNull();
    expect(await getAccountByEmail(db, "missing@example.com")).toBeNull();
  });

  it("updates the account-level unit-system preference", async () => {
    await createAccount(db, { id: "acc-units", displayName: "Units" });
    expect((await getAccount(db, "acc-units"))?.unitSystem).toBeNull();

    await updateAccountProfile(db, "acc-units", { unitSystem: "metric" });
    expect((await getAccount(db, "acc-units"))?.unitSystem).toBe("metric");
  });

  it("updates email confirmation and lifecycle stage", async () => {
    await createAccount(db, { id: "acc-2", displayName: "Liz" });

    await setEmailConfirmed(db, "acc-2", true);
    let row = await getAccount(db, "acc-2");
    expect(row?.emailConfirmed).toBe(true);

    await setLifecycleStage(db, "acc-2", "paying");
    row = await getAccount(db, "acc-2");
    expect(row?.lifecycleStage).toBe("paying");
  });

  it("adds and looks up identities", async () => {
    await createAccount(db, { id: "acc-3", displayName: "Provider One", providerKind: "primary" });

    const google = await addIdentity(db, { accountId: "acc-3", method: "google", providerSubject: "sub-123" });
    const passkey = await addIdentity(db, { accountId: "acc-3", method: "passkey", credentialId: "cred-123" });

    expect(await getIdentityByProviderSubject(db, "google", "sub-123")).toEqual(google);
    expect(await getIdentityByCredentialId(db, "cred-123")).toEqual(passkey);
    expect(await getIdentityByProviderSubject(db, "google", "missing")).toBeNull();
    expect(await getIdentityByCredentialId(db, "missing")).toBeNull();

    const list = await listIdentities(db, "acc-3");
    expect(list).toHaveLength(2);
    expect(list.map((i) => i.id).sort()).toEqual([google.id, passkey.id].sort());
  });

  it("round-trips credential blobs and kdf params", async () => {
    await createAccount(db, { id: "acc-4", displayName: "Cred Holder" });

    const wrappedPrivateKey = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
    const kdfParams = { algo: "pbkdf2", iterations: 100000, salt: "abc" };

    await putCredential(db, { accountId: "acc-4", method: "password", wrappedPrivateKey, kdfParams });

    const cred = await getCredential(db, "acc-4", "password");
    expect(cred).not.toBeNull();
    expect(Array.from(cred!.wrappedPrivateKey)).toEqual(Array.from(wrappedPrivateKey));
    expect(cred!.kdfParams).toEqual(kdfParams);

    expect(await getCredential(db, "acc-4", "google")).toBeNull();

    // INSERT OR REPLACE on (account_id, method)
    const wrappedPrivateKey2 = new Uint8Array([9, 9, 9]);
    await putCredential(db, { accountId: "acc-4", method: "password", wrappedPrivateKey: wrappedPrivateKey2, kdfParams });
    const cred2 = await getCredential(db, "acc-4", "password");
    expect(Array.from(cred2!.wrappedPrivateKey)).toEqual([9, 9, 9]);
  });

  it("round-trips public keys as JSON", async () => {
    await createAccount(db, { id: "acc-5", displayName: "Key Holder" });

    const publicKeyJwk = { kty: "EC", crv: "P-256", x: "abc", y: "def" };
    await putPublicKey(db, { accountId: "acc-5", publicKeyJwk });

    const pk = await getPublicKey(db, "acc-5");
    expect(pk?.publicKeyJwk).toEqual(publicKeyJwk);
    expect(await getPublicKey(db, "acc-missing")).toBeNull();
  });

  it("creates and lists vaults for an owner", async () => {
    await createAccount(db, { id: "acc-6", displayName: "Vault Owner" });

    const v1 = await createVault(db, { vaultId: "vault-1", ownerAccountId: "acc-6", r2Key: "r2/key/1", hd1Version: 1 });
    const v2 = await createVault(db, { vaultId: "vault-2", ownerAccountId: "acc-6", r2Key: "r2/key/2", hd1Version: 1 });

    expect(await getVault(db, "vault-1")).toEqual(v1);
    expect(await getVault(db, "vault-missing")).toBeNull();

    const list = await listVaultsForOwner(db, "acc-6");
    expect(list.map((v) => v.vaultId).sort()).toEqual(["vault-1", "vault-2"]);
    void v2;
  });

  it("manages vault envelopes (escrow set)", async () => {
    await createAccount(db, { id: "acc-7", displayName: "Envelope Owner" });
    await createAccount(db, { id: "acc-8", displayName: "Envelope Principal" });
    await createVault(db, { vaultId: "vault-3", ownerAccountId: "acc-7", r2Key: "r2/key/3", hd1Version: 1 });

    const wrappedDek = new Uint8Array([10, 20, 30, 40]);
    const ephemeralPublicKeyJwk = { kty: "EC", crv: "P-256", x: "ex", y: "ey" };

    await putEnvelope(db, {
      vaultId: "vault-3",
      principalAccountId: "acc-8",
      wrappedDek,
      ephemeralPublicKeyJwk,
      createdBy: "acc-7",
    });

    // getEnvelopeRow, not getEnvelope: this test is about STORAGE. acc-8 holds an envelope and has no
    // provider link, which since W71 is precisely the case getEnvelope refuses — see the access-rule
    // tests below.
    const env = await getEnvelopeRow(db, "vault-3", "acc-8");
    expect(env).not.toBeNull();
    expect(Array.from(env!.wrappedDek)).toEqual(Array.from(wrappedDek));
    expect(env!.ephemeralPublicKeyJwk).toEqual(ephemeralPublicKeyJwk);
    expect(env!.createdBy).toBe("acc-7");

    const byPrincipal = await listEnvelopesForPrincipal(db, "acc-8");
    expect(byPrincipal.map((e) => e.vaultId)).toEqual(["vault-3"]);

    const byVault = await listEnvelopesForVault(db, "vault-3");
    expect(byVault.map((e) => e.principalAccountId)).toEqual(["acc-8"]);

    await deleteEnvelope(db, "vault-3", "acc-8");
    expect(await getEnvelopeRow(db, "vault-3", "acc-8")).toBeNull();
  });

  // W71 — an expired support grant still decrypted, indefinitely.
  //
  // Expiry was enforced lazily and only inside the support/* routes: support/access.ts self-revokes a
  // lapsed grant, but only when the agent calls it again. GET /api/vault/{id} gated on the envelope
  // row alone, so an agent who had opened a patient once and kept the id could read full PHI forever
  // by simply never calling the endpoint that would revoke them. Nothing was logged.
  //
  // The check now lives in getEnvelope, so a route cannot forget it — including routes not yet
  // written. These assert the DECISION rather than which route asks for it.
  describe("an envelope is only usable while the grant behind it is", () => {
    const seed = async (tag: string, link?: { status: LinkStatus; expiresAt?: string | null }) => {
      const owner = `own-${tag}`, principal = `prin-${tag}`, vaultId = `v-${tag}`;
      await createAccount(db, { id: owner, displayName: "Patient" });
      await createAccount(db, { id: principal, displayName: "Agent", providerKind: "support" });
      await createVault(db, { vaultId, ownerAccountId: owner, r2Key: `r2/${tag}`, hd1Version: 2 });
      for (const p of [owner, principal]) {
        await putEnvelope(db, { vaultId, principalAccountId: p, wrappedDek: new Uint8Array([1]), ephemeralPublicKeyJwk: {}, createdBy: owner });
      }
      if (link) {
        await createProviderLink(db, { ownerAccountId: owner, providerAccountId: principal, role: "support", status: link.status, expiresAt: link.expiresAt ?? null, grantedBy: owner });
      }
      return { owner, principal, vaultId };
    };
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();

    it.each([
      ["an expired support grant", { status: "active" as const, expiresAt: past }, false],
      ["a revoked grant", { status: "revoked" as const, expiresAt: future }, false],
      ["an invitation never accepted", { status: "invited" as const, expiresAt: null }, false],
      ["no link at all — an envelope left behind", undefined, false],
      ["a live, time-boxed grant", { status: "active" as const, expiresAt: future }, true],
      ["an open-ended clinician link", { status: "active" as const, expiresAt: null }, true],
    ])("%s", async (tag, link, usable) => {
      const s = await seed(tag.replace(/\W+/g, "-"), link);
      // The row is there either way — that is what made this invisible.
      expect(await getEnvelopeRow(db, s.vaultId, s.principal)).not.toBeNull();
      expect(!!(await getEnvelope(db, s.vaultId, s.principal))).toBe(usable);
      // The patient is never locked out of their own vault by any of this.
      expect(await getEnvelope(db, s.vaultId, s.owner)).not.toBeNull();
    });

    it("is decided at read time from the link, not cached with the envelope", async () => {
      // Deliberately not a sleep-and-hope: nothing about the envelope changes here, only the link,
      // and the same call must answer differently afterwards. A `setTimeout` past a short expiry
      // would prove the same thing while failing spuriously on a loaded CI runner.
      const s = await seed("readtime", { status: "active", expiresAt: future });
      expect(await getEnvelope(db, s.vaultId, s.principal)).not.toBeNull();
      await db.prepare("UPDATE provider_links SET expires_at = ? WHERE provider_account_id = ?").bind(past, s.principal).run();
      expect(await getEnvelope(db, s.vaultId, s.principal)).toBeNull();
    });
  });

  it("manages provider links", async () => {
    await createAccount(db, { id: "acc-patient", displayName: "Patient" });
    await createAccount(db, { id: "acc-provider", displayName: "Provider", providerKind: "primary" });

    const link = await createProviderLink(db, {
      ownerAccountId: "acc-patient",
      providerAccountId: "acc-provider",
      role: "primary",
      grantedBy: "acc-patient",
    });
    expect(link.status).toBe("invited");

    const forPatient = await listProvidersForPatient(db, "acc-patient");
    expect(forPatient.map((l) => l.id)).toEqual([link.id]);

    const forProvider = await listPatientsForProvider(db, "acc-provider");
    expect(forProvider.map((l) => l.id)).toEqual([link.id]);

    await updateProviderLinkStatus(db, link.id, "active");
    const updated = await getProviderLink(db, link.id);
    expect(updated?.status).toBe("active");

    expect(await getProviderLink(db, "link-missing")).toBeNull();
  });

  it("records and syncs crm events", async () => {
    await createAccount(db, { id: "acc-crm", displayName: "CRM Subject" });

    const evt = await insertCrmEvent(db, {
      accountId: "acc-crm",
      event: "stage_changed",
      stageFrom: "lead",
      stageTo: "active",
      meta: { source: "test" },
    });
    expect(evt.syncedAt).toBeNull();
    expect(evt.meta).toEqual({ source: "test" });

    const list = await listCrmEvents(db, "acc-crm");
    expect(list.map((e) => e.id)).toEqual([evt.id]);

    await markCrmEventSynced(db, evt.id);
    const synced = await listCrmEvents(db, "acc-crm");
    expect(synced[0].syncedAt).not.toBeNull();
  });
});

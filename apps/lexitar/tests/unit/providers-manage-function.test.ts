import { describe, it, expect } from "vitest";
import { onRequestGet as lookup } from "../../functions/api/providers/lookup";
import { onRequestPost as grant } from "../../functions/api/providers/grant";
import { onRequestGet as myProviders } from "../../functions/api/providers/index";
import { onRequestDelete as revoke } from "../../functions/api/providers/[link]";
import { onRequestGet as patients } from "../../functions/api/providers/patients";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, getEnvelope, listVaultsForOwner } from "../../functions/_lib/identity-vault";
import { createProviderLink, listProvidersForPatient } from "../../functions/_lib/identity-providers";
import { listAccessEventsForSubject } from "../../functions/_lib/identity-audit";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

// Grant wraps the DEK to the provider's public key client-side (simulated here), then records the envelope + link.
const w = useWorkerd();
const makeEnv = () => ({ DB: w.db, SESSION_SECRET }) as any;
const bytesToBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

// Fresh patient (owned vault + in-memory DEK) and provider (provider_kind + public key) per test.
async function seed(email = `doc-${crypto.randomUUID()}@x.test`) {
  const patientId = crypto.randomUUID();
  await createAccount(w.db, { id: patientId, displayName: "Pat" });
  const vaultId = crypto.randomUUID();
  await createVault(w.db, { vaultId, ownerAccountId: patientId, r2Key: `data-${patientId}.enc`, hd1Version: 2 });
  const dek = await generateDEK();

  const prov = await generateAccountKeypair();
  const providerId = crypto.randomUUID();
  await createAccount(w.db, { id: providerId, displayName: "Dr Who", email, providerKind: "primary" });
  await putPublicKey(w.db, { accountId: providerId, publicKeyJwk: prov.publicKeyJwk });
  return { patientId, vaultId, dek, providerId, providerPublicKeyJwk: prov.publicKeyJwk, email };
}

async function doGrant(patientId: string, dek: CryptoKey, providerId: string, providerPublicKeyJwk: JsonWebKey) {
  const env0 = await wrapDEKForPublicKey(dek, providerPublicKeyJwk);
  return grant({
    request: new Request("http://x/api/providers/grant", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookieFor(patientId) },
      body: JSON.stringify({ providerAccountId: providerId, wrappedDEK: bytesToBase64(env0.wrappedDEK), ephemeralPublicKeyJwk: env0.ephemeralPublicKeyJwk }),
    }),
    env: makeEnv(),
  });
}

describe("provider lookup", () => {
  it("401s without a session", async () => {
    const res = await lookup({ request: new Request("http://x/api/providers/lookup?email=x@y.z"), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it("returns a provider's public key by email", async () => {
    const { providerId, email } = await seed();
    const patientId = crypto.randomUUID();
    await createAccount(w.db, { id: patientId, displayName: "P" });
    const res = await lookup({ request: new Request(`http://x/api/providers/lookup?email=${encodeURIComponent(email)}`, { headers: { cookie: await cookieFor(patientId) } }), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providerAccountId: string; publicKeyJwk: unknown };
    expect(body.providerAccountId).toBe(providerId);
    expect(body.publicKeyJwk).toBeTruthy();
  });

  it("uniform-404s a non-provider account (no enumeration of ordinary users)", async () => {
    const patientId = crypto.randomUUID();
    await createAccount(w.db, { id: patientId, displayName: "Plain", email: "plain@x.test" });
    const res = await lookup({ request: new Request("http://x/api/providers/lookup?email=plain@x.test", { headers: { cookie: await cookieFor(patientId) } }), env: makeEnv() });
    expect(res.status).toBe(404);
  });
});

describe("provider grant / list / revoke", () => {
  it("grants: writes an envelope + active link; the provider then sees the patient", async () => {
    const s = await seed();
    expect((await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk)).status).toBe(200);

    expect(await getEnvelope(w.db, s.vaultId, s.providerId)).not.toBeNull();

    const list = await myProviders({ request: new Request("http://x/api/providers", { headers: { cookie: await cookieFor(s.patientId) } }), env: makeEnv() });
    const { providers } = (await list.json()) as { providers: { providerAccountId: string; status: string }[] };
    expect(providers).toEqual([expect.objectContaining({ providerAccountId: s.providerId, status: "active" })]);

    const pl = await patients({ request: new Request("http://x/api/providers/patients", { headers: { cookie: await cookieFor(s.providerId) } }), env: makeEnv() });
    const { patients: seen } = (await pl.json()) as { patients: { ownerAccountId: string }[] };
    expect(seen.map((p) => p.ownerAccountId)).toContain(s.patientId);
  });

  it("writes the consent row the patient's own access screen reads", async () => {
    // The grant audited nothing until now while its opposite, `provider_access_revoked`, was
    // written — so a patient's log read as though access had always been there. Actor and subject
    // are both the owner: this is their act on their own record, which is why it does not go
    // through the privileged-read chokepoint, whose owner exclusion would drop it.
    const s = await seed();
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    const events = await listAccessEventsForSubject(w.db, s.patientId);
    expect(events.map((e) => e.action)).toEqual(["provider_access_granted"]);
    expect(events[0]).toMatchObject({ actorAccountId: s.patientId, subjectAccountId: s.patientId, vaultId: s.vaultId });
  });

  it("attaches the asker's public key to ANY invited link, not only a support one", async () => {
    // Approve wraps the patient's DEK to this key. The narrower test this replaces failed silently
    // rather than loudly — `approve()` returns early on a missing key, so the patient would press
    // the button and watch nothing happen.
    const s = await seed();
    await createProviderLink(w.db, {
      ownerAccountId: s.patientId,
      providerAccountId: s.providerId,
      role: "primary",
      status: "invited",
      grantedBy: s.providerId,
    });
    const list = await myProviders({ request: new Request("http://x/api/providers", { headers: { cookie: await cookieFor(s.patientId) } }), env: makeEnv() });
    const { providers } = (await list.json()) as { providers: { kind: string; status: string; publicKeyJwk?: unknown }[] };
    expect(providers).toEqual([expect.objectContaining({ kind: "primary", status: "invited" })]);
    expect(providers[0].publicKeyJwk).toBeTruthy();
  });

  it("does not hand out a public key for a link that is already active", async () => {
    // Nothing is wrapped for an active link — the envelope exists — so the key would be a disclosure
    // with no use for it.
    const s = await seed();
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    const list = await myProviders({ request: new Request("http://x/api/providers", { headers: { cookie: await cookieFor(s.patientId) } }), env: makeEnv() });
    const { providers } = (await list.json()) as { providers: Record<string, unknown>[] };
    expect(providers[0]).not.toHaveProperty("publicKeyJwk");
  });

  it("rejects granting to a non-provider account", async () => {
    const s = await seed();
    const plainId = crypto.randomUUID();
    await createAccount(w.db, { id: plainId, displayName: "Plain" });
    const res = await doGrant(s.patientId, s.dek, plainId, s.providerPublicKeyJwk);
    expect(res.status).toBe(400);
  });

  it("re-granting is idempotent (no duplicate links)", async () => {
    const s = await seed();
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    const links = await listProvidersForPatient(w.db, s.patientId);
    expect(links.filter((l) => l.providerAccountId === s.providerId)).toHaveLength(1);
  });

  it("revokes: deletes the envelope, marks the link revoked, drops it from both views", async () => {
    const s = await seed();
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    const linkId = (await listProvidersForPatient(w.db, s.patientId)).find((l) => l.providerAccountId === s.providerId)!.id;

    const res = await revoke({ request: new Request(`http://x/api/providers/${linkId}`, { method: "DELETE", headers: { cookie: await cookieFor(s.patientId) } }), env: makeEnv(), params: { link: linkId } });
    expect(res.status).toBe(200);

    expect(await getEnvelope(w.db, s.vaultId, s.providerId)).toBeNull();
    const list = await myProviders({ request: new Request("http://x/api/providers", { headers: { cookie: await cookieFor(s.patientId) } }), env: makeEnv() });
    const { providers } = (await list.json()) as { providers: unknown[] };
    expect(providers).toHaveLength(0);
    const pl = await patients({ request: new Request("http://x/api/providers/patients", { headers: { cookie: await cookieFor(s.providerId) } }), env: makeEnv() });
    const { patients: seen } = (await pl.json()) as { patients: unknown[] };
    expect(seen).toHaveLength(0);
  });

  it("W48: the provider on the link may revoke their own access (drop the patient)", async () => {
    const s = await seed();
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    const linkId = (await listProvidersForPatient(w.db, s.patientId)).find((l) => l.providerAccountId === s.providerId)!.id;

    // The PROVIDER (not the patient) revokes.
    const res = await revoke({ request: new Request(`http://x/api/providers/${linkId}`, { method: "DELETE", headers: { cookie: await cookieFor(s.providerId) } }), env: makeEnv(), params: { link: linkId } });
    expect(res.status).toBe(200);

    // The provider's envelope on the PATIENT's vault is gone; the patient drops from the provider's view.
    expect(await getEnvelope(w.db, s.vaultId, s.providerId)).toBeNull();
    const pl = await patients({ request: new Request("http://x/api/providers/patients", { headers: { cookie: await cookieFor(s.providerId) } }), env: makeEnv() });
    const { patients: seen } = (await pl.json()) as { patients: unknown[] };
    expect(seen).toHaveLength(0);
    // The patient still owns their vault (only the provider's access was removed).
    expect((await listVaultsForOwner(w.db, s.patientId)).length).toBe(1);
  });

  it("403s revoking another patient's link", async () => {
    const s = await seed();
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    const linkId = (await listProvidersForPatient(w.db, s.patientId)).find((l) => l.providerAccountId === s.providerId)!.id;
    const otherId = crypto.randomUUID();
    await createAccount(w.db, { id: otherId, displayName: "Other" });
    const res = await revoke({ request: new Request(`http://x/api/providers/${linkId}`, { method: "DELETE", headers: { cookie: await cookieFor(otherId) } }), env: makeEnv(), params: { link: linkId } });
    expect(res.status).toBe(403);
  });
});

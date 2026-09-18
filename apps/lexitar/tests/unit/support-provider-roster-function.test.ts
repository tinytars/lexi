import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestPost as request } from "../../functions/api/support/request";
import { onRequestPost as approveSupport } from "../../functions/api/providers/approve-support";
import { onRequestGet as supportProviders } from "../../functions/api/support/providers";
import { onRequestGet as providerRoster } from "../../functions/api/support/provider-roster";
import { onRequestGet as supportRequests } from "../../functions/api/support/requests";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink, getProviderLink } from "../../functions/_lib/identity-providers";
import { listAccessEventsForSubject } from "../../functions/_lib/identity-audit";
import { signSession } from "../../functions/_lib/session";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

// W50 — support→provider roster access. A support agent requests a clinician's roster; the clinician
// approves (metadata only, no envelope); support then sees the roster and can open only the patients
// who separately consented to support.

let mf: Miniflare;
let db: any;
const SECRET = "test-secret";

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-w50" } });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
});
afterAll(async () => { await mf.dispose(); });

const makeEnv = () => ({ DB: db, SESSION_SECRET: SECRET }) as any;
const cookieFor = async (id: string) => `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}`;

async function callPost(fn: any, actorId: string, body: unknown) {
  return fn({ request: new Request("http://x", { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor(actorId) }, body: JSON.stringify(body) }), env: makeEnv() });
}
async function callGet(fn: any, actorId: string, query = "") {
  return fn({ request: new Request(`http://x/y${query}`, { headers: { cookie: await cookieFor(actorId) } }), env: makeEnv() });
}

async function seedSupport() {
  const kp = await generateAccountKeypair();
  const id = crypto.randomUUID();
  const email = `support-${id}@x.test`;
  await createAccount(db, { id, displayName: "Support", email, providerKind: "support" });
  await putPublicKey(db, { accountId: id, publicKeyJwk: kp.publicKeyJwk });
  return { id, publicKeyJwk: kp.publicKeyJwk, email };
}
async function seedClinician() {
  const id = crypto.randomUUID();
  const email = `clin-${id}@x.test`;
  await createAccount(db, { id, displayName: "Dr Who", email, providerKind: "primary" });
  return { id, email };
}
async function seedPatient() {
  const id = crypto.randomUUID();
  const email = `pat-${id}@x.test`;
  await createAccount(db, { id, displayName: "Pat", email });
  const vaultId = crypto.randomUUID();
  await createVault(db, { vaultId, ownerAccountId: id, r2Key: `data-${id}.enc`, hd1Version: 2 });
  return { id, vaultId, dek: await generateDEK(), email };
}
// A patient on a clinician's roster (patient granted the clinician).
async function addToRoster(clinicianId: string, patientId: string) {
  await createProviderLink(db, { ownerAccountId: patientId, providerAccountId: clinicianId, role: "primary", status: "active", grantedBy: patientId });
}
// A patient who has separately granted this support agent access (active envelope).
async function consentToSupport(supportId: string, supportPub: JsonWebKey, p: { id: string; vaultId: string; dek: CryptoKey }) {
  await createProviderLink(db, { ownerAccountId: p.id, providerAccountId: supportId, role: "support", status: "active", grantedBy: p.id });
  const e = await wrapDEKForPublicKey(p.dek, supportPub);
  await putEnvelope(db, { vaultId: p.vaultId, principalAccountId: supportId, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: p.id });
}

describe("support→provider request classification", () => {
  it("a clinician target creates a roster request audited as support_provider_access_requested", async () => {
    const s = await seedSupport();
    const c = await seedClinician();
    const res = await callPost(request, s.id, { ownerEmail: c.email });
    expect(res.status).toBe(200);
    expect((await res.json() as { target: string }).target).toBe("provider");
    expect((await listAccessEventsForSubject(db, c.id)).map((e) => e.action)).toContain("support_provider_access_requested");
  });

  it("rejects a support-agent target and a self target", async () => {
    const s = await seedSupport();
    const s2 = await seedSupport();
    expect((await callPost(request, s.id, { ownerEmail: s2.email })).status).toBe(400);
    expect((await callPost(request, s.id, { ownerEmail: s.email })).status).toBe(400);
  });
});

describe("provider approves a support roster request", () => {
  it("clinician approve flips the link active with an expiry + audit; support then lists the provider", async () => {
    const s = await seedSupport();
    const c = await seedClinician();
    const linkId = (await (await callPost(request, s.id, { ownerEmail: c.email })).json() as { linkId: string }).linkId;

    const ap = await callPost(approveSupport, c.id, { linkId, ttlHours: 24 });
    expect(ap.status).toBe(200);
    expect((await getProviderLink(db, linkId))!.status).toBe("active");
    expect((await listAccessEventsForSubject(db, c.id)).map((e) => e.action)).toContain("support_provider_access_granted");

    const list = await callGet(supportProviders, s.id);
    const providers = (await list.json() as { providers: { providerAccountId: string }[] }).providers;
    expect(providers.map((p) => p.providerAccountId)).toContain(c.id);
  });

  it("a non-provider (patient) cannot use the crypto-free provider approve path", async () => {
    const p = await seedPatient();
    const res = await callPost(approveSupport, p.id, { linkId: crypto.randomUUID(), ttlHours: 24 });
    expect(res.status).toBe(403);
  });
});

describe("provider roster marks openable only for patient-consented records", () => {
  it("consented patient is openable; non-consented is visible but not openable", async () => {
    const s = await seedSupport();
    const c = await seedClinician();
    const consented = await seedPatient();
    const other = await seedPatient();
    await addToRoster(c.id, consented.id);
    await addToRoster(c.id, other.id);
    await consentToSupport(s.id, s.publicKeyJwk, consented);

    // support gets the clinician's roster
    const linkId = (await (await callPost(request, s.id, { ownerEmail: c.email })).json() as { linkId: string }).linkId;
    await callPost(approveSupport, c.id, { linkId, ttlHours: 24 });

    const res = await callGet(providerRoster, s.id, `?providerId=${c.id}`);
    expect(res.status).toBe(200);
    const roster = (await res.json() as { roster: { ownerAccountId: string; openable: boolean }[] }).roster;
    const byId = Object.fromEntries(roster.map((r) => [r.ownerAccountId, r.openable]));
    expect(byId[consented.id]).toBe(true);
    expect(byId[other.id]).toBe(false);
    expect((await listAccessEventsForSubject(db, c.id)).map((e) => e.action)).toContain("support_provider_roster_viewed");
  });

  it("no active grant → the roster endpoint 403s", async () => {
    const s = await seedSupport();
    const c = await seedClinician();
    const res = await callGet(providerRoster, s.id, `?providerId=${c.id}`);
    expect(res.status).toBe(403);
  });
});

describe("pending requests are visible to the requester", () => {
  it("support/requests lists invited patient + provider requests with their kind", async () => {
    const s = await seedSupport();
    const p = await seedPatient();
    const c = await seedClinician();
    await callPost(request, s.id, { ownerEmail: p.email });
    await callPost(request, s.id, { ownerEmail: c.email });

    const res = await callGet(supportRequests, s.id);
    expect(res.status).toBe(200);
    const reqs = (await res.json() as { requests: { targetAccountId: string; kind: string }[] }).requests;
    const byId = Object.fromEntries(reqs.map((r) => [r.targetAccountId, r.kind]));
    expect(byId[p.id]).toBe("owner");
    expect(byId[c.id]).toBe("provider");
  });

  it("a patient with an outstanding request shows pending=true in the provider roster", async () => {
    const s = await seedSupport();
    const c = await seedClinician();
    const p = await seedPatient();
    await addToRoster(c.id, p.id);
    const linkId = (await (await callPost(request, s.id, { ownerEmail: c.email })).json() as { linkId: string }).linkId;
    await callPost(approveSupport, c.id, { linkId, ttlHours: 24 });
    await callPost(request, s.id, { ownerEmail: p.email }); // invited, not yet approved

    const roster = (await (await callGet(providerRoster, s.id, `?providerId=${c.id}`)).json() as { roster: { ownerAccountId: string; openable: boolean; pending: boolean }[] }).roster;
    const row = roster.find((r) => r.ownerAccountId === p.id)!;
    expect(row.pending).toBe(true);
    expect(row.openable).toBe(false);
  });
});

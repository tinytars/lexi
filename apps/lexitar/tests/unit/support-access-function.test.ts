import { describe, it, expect, vi } from "vitest";
import { onRequestPost as request } from "../../functions/api/support/request";
import { onRequestPost as approve } from "../../functions/api/support/approve";
import { onRequestPost as access } from "../../functions/api/support/access";
import { onRequestGet as supportPatients } from "../../functions/api/support/owners";
import { onRequestGet as clinicianPatients } from "../../functions/api/providers/patients";
import { onRequestGet as providerToken } from "../../functions/api/provider-token";
import { onRequestDelete as revoke } from "../../functions/api/providers/[link]";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, getEnvelope, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink, getProviderLink } from "../../functions/_lib/identity-providers";
import { listAccessEventsForSubject } from "../../functions/_lib/identity-audit";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { listSupportOwners } from "@tinytars/vault/auth-support";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const w = useWorkerd();
const makeEnv = (extra: Record<string, unknown> = {}) => ({ DB: w.db, SESSION_SECRET, ...extra }) as any;
const bytesToBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

async function callPost(fn: any, actorId: string, body: unknown, env = makeEnv()) {
  return fn({ request: new Request("http://x", { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor(actorId) }, body: JSON.stringify(body) }), env });
}

async function seedSupport(email = `support-${crypto.randomUUID()}@x.test`) {
  const kp = await generateAccountKeypair();
  const supportId = crypto.randomUUID();
  await createAccount(w.db, { id: supportId, displayName: "Support", email, providerKind: "support" });
  await putPublicKey(w.db, { accountId: supportId, publicKeyJwk: kp.publicKeyJwk });
  return { supportId, supportPublicKeyJwk: kp.publicKeyJwk, email };
}
async function seedPatient(email = `pat-${crypto.randomUUID()}@x.test`) {
  const patientId = crypto.randomUUID();
  await createAccount(w.db, { id: patientId, displayName: "Pat", email });
  const vaultId = crypto.randomUUID();
  await createVault(w.db, { vaultId, ownerAccountId: patientId, r2Key: `data-${patientId}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  return { patientId, vaultId, dek, email };
}
async function wrap(dek: CryptoKey, pub: JsonWebKey) {
  const e = await wrapDEKForPublicKey(dek, pub);
  return { wrappedDEK: bytesToBase64(e.wrappedDEK), ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk };
}

describe("support request → approve → enter", () => {
  it("full happy path writes the audit trail and returns the envelope on enter", async () => {
    const s = await seedSupport();
    const p = await seedPatient();

    // request
    const rq = await callPost(request, s.supportId, { ownerEmail: p.email });
    expect(rq.status).toBe(200);
    const linkId = (await rq.json() as { linkId: string }).linkId;

    // approve (patient wraps DEK to support pubkey)
    const ap = await callPost(approve, p.patientId, { linkId, ...(await wrap(p.dek, s.supportPublicKeyJwk)), ttlHours: 24 });
    expect(ap.status).toBe(200);
    expect(await getEnvelope(w.db, p.vaultId, s.supportId)).not.toBeNull();

    // enter (audited)
    const en = await callPost(access, s.supportId, { ownerAccountId: p.patientId });
    expect(en.status).toBe(200);
    expect((await en.json() as { envelope: { wrappedDEK: string } }).envelope.wrappedDEK).toBeTruthy();

    const events = (await listAccessEventsForSubject(w.db, p.patientId)).map((e) => e.action);
    expect(events).toEqual(["support_access_requested", "support_access_granted", "support_access_opened"]);
  });

  it("rejects a non-support requester and a non-patient approver", async () => {
    const p = await seedPatient();
    const notSupport = crypto.randomUUID();
    await createAccount(w.db, { id: notSupport, displayName: "Nope" });
    expect((await callPost(request, notSupport, { ownerEmail: p.email })).status).toBe(403);
  });

  it("expired grant self-revokes on enter, audits support_access_expired, deletes the envelope", async () => {
    const s = await seedSupport();
    const p = await seedPatient();
    // an already-active support link with a PAST expiry + a live envelope
    const link = await createProviderLink(w.db, {
      ownerAccountId: p.patientId, providerAccountId: s.supportId, role: "support",
      status: "active", grantedBy: p.patientId, expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const e = await wrapDEKForPublicKey(p.dek, s.supportPublicKeyJwk);
    await putEnvelope(w.db, { vaultId: p.vaultId, principalAccountId: s.supportId, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: p.patientId });

    const en = await callPost(access, s.supportId, { ownerAccountId: p.patientId });
    expect(en.status).toBe(403);
    expect(await getEnvelope(w.db, p.vaultId, s.supportId)).toBeNull();
    expect((await getProviderLink(w.db, link.id))!.status).toBe("revoked");
    expect((await listAccessEventsForSubject(w.db, p.patientId)).map((x) => x.action)).toContain("support_access_expired");
  });

  it("denying a support request audits support_access_denied", async () => {
    const s = await seedSupport();
    const p = await seedPatient();
    const linkId = (await (await callPost(request, s.supportId, { ownerEmail: p.email })).json() as { linkId: string }).linkId;
    const res = await revoke({ request: new Request(`http://x/api/providers/${linkId}`, { method: "DELETE", headers: { cookie: await cookieFor(p.patientId) } }), env: makeEnv(), params: { link: linkId } });
    expect(res.status).toBe(200);
    expect((await listAccessEventsForSubject(w.db, p.patientId)).map((x) => x.action)).toContain("support_access_denied");
  });
});

describe("support is walled off from clinician surfaces", () => {
  it("a support link never appears in the clinician /api/providers/patients path", async () => {
    const s = await seedSupport();
    const p = await seedPatient();
    // grant support an active link + envelope
    await createProviderLink(w.db, { ownerAccountId: p.patientId, providerAccountId: s.supportId, role: "support", status: "active", grantedBy: p.patientId });
    const e = await wrapDEKForPublicKey(p.dek, s.supportPublicKeyJwk);
    await putEnvelope(w.db, { vaultId: p.vaultId, principalAccountId: s.supportId, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: p.patientId });

    const res = await clinicianPatients({ request: new Request("http://x/api/providers/patients", { headers: { cookie: await cookieFor(s.supportId) } }), env: makeEnv() });
    expect((await res.json() as { patients: unknown[] }).patients).toHaveLength(0);
    // but it DOES appear in the support console
    const sc = await supportPatients({ request: new Request("http://x/api/support/owners", { headers: { cookie: await cookieFor(s.supportId) } }), env: makeEnv() });
    expect((await sc.json() as { owners: unknown[] }).owners).toHaveLength(1);
  });

  it("a support account does not receive the refresh-finding provider token", async () => {
    const s = await seedSupport();
    const res = await providerToken({ request: new Request("http://x/api/provider-token", { headers: { cookie: await cookieFor(s.supportId) } }), env: makeEnv({ PROVIDER_TOKEN: "tok" }) });
    expect(res.status).toBe(403);
  });
});

// The route and its parser live in different packages; pipe the real Response through the real parser.
describe("the owners route and the published vault client agree on the wire shape", () => {
  it("listSupportOwners() parses a real /api/support/owners response into a non-empty list", async () => {
    const s = await seedSupport();
    const p = await seedPatient();
    await createProviderLink(w.db, { ownerAccountId: p.patientId, providerAccountId: s.supportId, role: "support", status: "active", grantedBy: p.patientId });
    const e = await wrapDEKForPublicKey(p.dek, s.supportPublicKeyJwk);
    await putEnvelope(w.db, { vaultId: p.vaultId, principalAccountId: s.supportId, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: p.patientId });

    const cookie = await cookieFor(s.supportId);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
      expect(url).toBe("/api/support/owners");
      return supportPatients({ request: new Request(`http://x${url}`, { headers: { cookie } }), env: makeEnv() });
    }) as typeof fetch);
    try {
      const owners = await listSupportOwners();
      expect(owners).toHaveLength(1);
      expect(owners[0].ownerAccountId).toBe(p.patientId);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

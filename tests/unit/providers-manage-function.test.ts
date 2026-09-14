import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestGet as lookup } from "../../functions/api/providers/lookup";
import { onRequestPost as grant } from "../../functions/api/providers/grant";
import { onRequestGet as myProviders } from "../../functions/api/providers/index";
import { onRequestDelete as revoke } from "../../functions/api/providers/[link]";
import { onRequestGet as patients } from "../../functions/api/providers/patients";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, getEnvelope, listVaultsForOwner } from "../../functions/_lib/identity-vault";
import { listProvidersForPatient } from "../../functions/_lib/identity-providers";
import { signSession } from "../../functions/_lib/session";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

// W44 P4 — patient-initiated clinician grant/revoke over a real Miniflare D1. Grant wraps the DEK to
// the provider's public key client-side (simulated here), then records the opaque envelope + link.

let mf: Miniflare;
let db: any;
const SECRET = "test-secret";

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-providers-manage" } });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
});
afterAll(async () => { await mf.dispose(); });

const makeEnv = () => ({ DB: db, SESSION_SECRET: SECRET }) as any;
const bytesToBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const cookieFor = async (id: string) => `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}`;

// Fresh patient (owned vault + in-memory DEK) and provider (provider_kind + public key) per test.
async function seed(email = `doc-${crypto.randomUUID()}@x.test`) {
  const patientId = crypto.randomUUID();
  await createAccount(db, { id: patientId, displayName: "Pat" });
  const vaultId = crypto.randomUUID();
  await createVault(db, { vaultId, ownerAccountId: patientId, r2Key: `data-${patientId}.enc`, hd1Version: 2 });
  const dek = await generateDEK();

  const prov = await generateAccountKeypair();
  const providerId = crypto.randomUUID();
  await createAccount(db, { id: providerId, displayName: "Dr Who", email, providerKind: "primary" });
  await putPublicKey(db, { accountId: providerId, publicKeyJwk: prov.publicKeyJwk });
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
    await createAccount(db, { id: patientId, displayName: "P" });
    const res = await lookup({ request: new Request(`http://x/api/providers/lookup?email=${encodeURIComponent(email)}`, { headers: { cookie: await cookieFor(patientId) } }), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providerAccountId: string; publicKeyJwk: unknown };
    expect(body.providerAccountId).toBe(providerId);
    expect(body.publicKeyJwk).toBeTruthy();
  });

  it("uniform-404s a non-provider account (no enumeration of ordinary users)", async () => {
    const patientId = crypto.randomUUID();
    await createAccount(db, { id: patientId, displayName: "Plain", email: "plain@x.test" });
    const res = await lookup({ request: new Request("http://x/api/providers/lookup?email=plain@x.test", { headers: { cookie: await cookieFor(patientId) } }), env: makeEnv() });
    expect(res.status).toBe(404);
  });
});

describe("provider grant / list / revoke", () => {
  it("grants: writes an envelope + active link; the provider then sees the patient", async () => {
    const s = await seed();
    expect((await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk)).status).toBe(200);

    expect(await getEnvelope(db, s.vaultId, s.providerId)).not.toBeNull();

    const list = await myProviders({ request: new Request("http://x/api/providers", { headers: { cookie: await cookieFor(s.patientId) } }), env: makeEnv() });
    const { providers } = (await list.json()) as { providers: { providerAccountId: string; status: string }[] };
    expect(providers).toEqual([expect.objectContaining({ providerAccountId: s.providerId, status: "active" })]);

    const pl = await patients({ request: new Request("http://x/api/providers/patients", { headers: { cookie: await cookieFor(s.providerId) } }), env: makeEnv() });
    const { patients: seen } = (await pl.json()) as { patients: { ownerAccountId: string }[] };
    expect(seen.map((p) => p.ownerAccountId)).toContain(s.patientId);
  });

  it("rejects granting to a non-provider account", async () => {
    const s = await seed();
    const plainId = crypto.randomUUID();
    await createAccount(db, { id: plainId, displayName: "Plain" });
    const res = await doGrant(s.patientId, s.dek, plainId, s.providerPublicKeyJwk);
    expect(res.status).toBe(400);
  });

  it("re-granting is idempotent (no duplicate links)", async () => {
    const s = await seed();
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    const links = await listProvidersForPatient(db, s.patientId);
    expect(links.filter((l) => l.providerAccountId === s.providerId)).toHaveLength(1);
  });

  it("revokes: deletes the envelope, marks the link revoked, drops it from both views", async () => {
    const s = await seed();
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    const linkId = (await listProvidersForPatient(db, s.patientId)).find((l) => l.providerAccountId === s.providerId)!.id;

    const res = await revoke({ request: new Request(`http://x/api/providers/${linkId}`, { method: "DELETE", headers: { cookie: await cookieFor(s.patientId) } }), env: makeEnv(), params: { link: linkId } });
    expect(res.status).toBe(200);

    expect(await getEnvelope(db, s.vaultId, s.providerId)).toBeNull();
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
    const linkId = (await listProvidersForPatient(db, s.patientId)).find((l) => l.providerAccountId === s.providerId)!.id;

    // The PROVIDER (not the patient) revokes.
    const res = await revoke({ request: new Request(`http://x/api/providers/${linkId}`, { method: "DELETE", headers: { cookie: await cookieFor(s.providerId) } }), env: makeEnv(), params: { link: linkId } });
    expect(res.status).toBe(200);

    // The provider's envelope on the PATIENT's vault is gone; the patient drops from the provider's view.
    expect(await getEnvelope(db, s.vaultId, s.providerId)).toBeNull();
    const pl = await patients({ request: new Request("http://x/api/providers/patients", { headers: { cookie: await cookieFor(s.providerId) } }), env: makeEnv() });
    const { patients: seen } = (await pl.json()) as { patients: unknown[] };
    expect(seen).toHaveLength(0);
    // The patient still owns their vault (only the provider's access was removed).
    expect((await listVaultsForOwner(db, s.patientId)).length).toBe(1);
  });

  it("403s revoking another patient's link", async () => {
    const s = await seed();
    await doGrant(s.patientId, s.dek, s.providerId, s.providerPublicKeyJwk);
    const linkId = (await listProvidersForPatient(db, s.patientId)).find((l) => l.providerAccountId === s.providerId)!.id;
    const otherId = crypto.randomUUID();
    await createAccount(db, { id: otherId, displayName: "Other" });
    const res = await revoke({ request: new Request(`http://x/api/providers/${linkId}`, { method: "DELETE", headers: { cookie: await cookieFor(otherId) } }), env: makeEnv(), params: { link: linkId } });
    expect(res.status).toBe(403);
  });
});

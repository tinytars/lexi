import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestPost as mintEnvelope, onRequestDelete as revokeEnvelope } from "../../functions/api/vault/recovery-envelope";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { createVault, getEnvelope, getVault, setOrgRecoveryRevoked } from "../../functions/_lib/identity-vault";
import { listAccessEventsForSubject } from "../../functions/_lib/identity-audit";
import { signSession } from "../../functions/_lib/session";
import { ORG_ACCOUNT_ID } from "../../functions/_lib/org";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

let mf: Miniflare;
let db: any;
const SECRET = "test-secret";

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-recovery-envelope" } });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
  await createAccount(db, { id: ORG_ACCOUNT_ID, displayName: "Org" });
});
afterAll(async () => { await mf.dispose(); });

const makeEnv = () => ({ DB: db, SESSION_SECRET: SECRET }) as any;
const cookieFor = async (id: string) => `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}`;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

async function seedVault() {
  const ownerId = crypto.randomUUID();
  await createAccount(db, { id: ownerId, displayName: "Owner" });
  const vaultId = crypto.randomUUID();
  await createVault(db, { vaultId, ownerAccountId: ownerId, r2Key: `data-${ownerId}.enc`, hd1Version: 2 });
  return { ownerId, vaultId };
}

// The server never inspects the wrapping — it only stores what the client sends — so any real
// wrapped-DEK shape suffices here; there's no "wrong" one to also cover.
async function envelopeBody() {
  const dek = await generateDEK();
  const { publicKeyJwk } = await generateAccountKeypair();
  const e = await wrapDEKForPublicKey(dek, publicKeyJwk);
  return { wrappedDEK: b64(e.wrappedDEK), ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk };
}

function postReq(cookie?: string, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://x/api/vault/recovery-envelope", { method: "POST", headers, body: JSON.stringify(body ?? {}) });
}
function deleteReq(cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new Request("http://x/api/vault/recovery-envelope", { method: "DELETE", headers });
}

describe("POST /api/vault/recovery-envelope", () => {
  it("401s unauthenticated", async () => {
    const res = await mintEnvelope({ request: postReq(undefined, await envelopeBody()), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it("creates the org envelope (201) and logs org_recovery_minted", async () => {
    const { ownerId, vaultId } = await seedVault();
    const res = await mintEnvelope({ request: postReq(await cookieFor(ownerId), await envelopeBody()), env: makeEnv() });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: "created" });

    expect(await getEnvelope(db, vaultId, ORG_ACCOUNT_ID)).not.toBeNull();

    const events = await listAccessEventsForSubject(db, ownerId);
    const minted = events.find((e) => e.action === "org_recovery_minted");
    expect(minted).toBeTruthy();
    expect(minted!.vaultId).toBe(vaultId);
  });

  it("is idempotent: a second mint returns 200 exists", async () => {
    const { ownerId } = await seedVault();
    const cookie = await cookieFor(ownerId);
    const first = await mintEnvelope({ request: postReq(cookie, await envelopeBody()), env: makeEnv() });
    expect(first.status).toBe(201);

    const second = await mintEnvelope({ request: postReq(cookie, await envelopeBody()), env: makeEnv() });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "exists" });
  });

  it("409s once org_recovery_revoked_at is set", async () => {
    const { ownerId, vaultId } = await seedVault();
    await setOrgRecoveryRevoked(db, vaultId, new Date().toISOString());

    const res = await mintEnvelope({ request: postReq(await cookieFor(ownerId), await envelopeBody()), env: makeEnv() });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/vault/recovery-envelope", () => {
  it("401s unauthenticated", async () => {
    const res = await revokeEnvelope({ request: deleteReq(), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it("removes the envelope, stamps org_recovery_revoked_at, and logs org_recovery_revoked", async () => {
    const { ownerId, vaultId } = await seedVault();
    const cookie = await cookieFor(ownerId);
    await mintEnvelope({ request: postReq(cookie, await envelopeBody()), env: makeEnv() });
    expect(await getEnvelope(db, vaultId, ORG_ACCOUNT_ID)).not.toBeNull();

    const res = await revokeEnvelope({ request: deleteReq(cookie), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; revokedAt: string };
    expect(body.status).toBe("revoked");
    expect(body.revokedAt).toBeTruthy();

    expect(await getEnvelope(db, vaultId, ORG_ACCOUNT_ID)).toBeNull();
    expect((await getVault(db, vaultId))!.orgRecoveryRevokedAt).toBe(body.revokedAt);

    const events = await listAccessEventsForSubject(db, ownerId);
    expect(events.map((e) => e.action)).toContain("org_recovery_revoked");
  });

  it("is idempotent: a second revoke keeps the original revokedAt", async () => {
    const { ownerId } = await seedVault();
    const cookie = await cookieFor(ownerId);
    const first = await revokeEnvelope({ request: deleteReq(cookie), env: makeEnv() });
    const firstBody = (await first.json()) as { revokedAt: string };

    const second = await revokeEnvelope({ request: deleteReq(cookie), env: makeEnv() });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { revokedAt: string };
    expect(secondBody.revokedAt).toBe(firstBody.revokedAt);
  });
});

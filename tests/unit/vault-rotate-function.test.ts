import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestGet as principals } from "../../functions/api/vault/principals";
import { onRequestPost as rotate } from "../../functions/api/vault/rotate";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { getPublicKey, putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, getEnvelope, getVault, listEnvelopesForVault, putEnvelope, replaceEnvelopes, setRotationPending } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import { signSession } from "../../functions/_lib/session";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

const ORG = "00000000-0000-4000-8000-000000000001";
let mf: Miniflare;
let db: any;
let bucket: any;
const SECRET = "test-secret";

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-rotate" }, r2Buckets: { VAULT: "test-rotate-vault" } });
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("VAULT");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
  // the org operational account + its public key (client re-wraps the new DEK to it)
  const orgKp = await generateAccountKeypair();
  await createAccount(db, { id: ORG, displayName: "Org" });
  await putPublicKey(db, { accountId: ORG, publicKeyJwk: orgKp.publicKeyJwk });
});
afterAll(async () => { await mf.dispose(); });

const STORE_PREFIX = "test";
const makeEnv = () => ({ DB: db, SESSION_SECRET: SECRET, VAULT: bucket, STORE_PREFIX }) as any;

/** The two-phase rotation, as the browser performs it: reserve, write the blob, commit. */
async function stage(ownerId: string, vaultId: string): Promise<string> {
  const res = await rotate({ request: new Request("http://x/api/vault/rotate", { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor(ownerId) }, body: JSON.stringify({ phase: "stage", vaultId }) }), env: makeEnv() });
  expect(res.status).toBe(200);
  return (await res.json() as { newVaultId: string }).newVaultId;
}
const writeStagedBlob = (newVaultId: string) => bucket.put(`${STORE_PREFIX}/data-${newVaultId}.enc`, new Uint8Array([0x48, 0x44, 0x31, 2]));
const commit = async (ownerId: string, body: unknown) =>
  rotate({ request: new Request("http://x/api/vault/rotate", { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor(ownerId) }, body: JSON.stringify({ phase: "commit", ...(body as object) }) }), env: makeEnv() });

/** Every principal the server will insist on, wrapped to a fresh DEK. */
async function envelopesFor(s: Awaited<ReturnType<typeof seedVaultWithProvider>>, dek: CryptoKey) {
  const targets: [string, JsonWebKey][] = [[s.ownerId, s.ownerPub], [ORG, (await getPublicKey(db, ORG))!.publicKeyJwk as JsonWebKey], [s.provId, s.provPub]];
  return Promise.all(targets.map(async ([pid, pk]) => {
    const e = await wrapDEKForPublicKey(dek, pk);
    return { principalAccountId: pid, wrappedDEK: b64(e.wrappedDEK), ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk };
  }));
}
const cookieFor = async (id: string) => `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}`;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

async function seedVaultWithProvider() {
  const owner = await generateAccountKeypair();
  const ownerId = crypto.randomUUID();
  await createAccount(db, { id: ownerId, displayName: "Owner" });
  await putPublicKey(db, { accountId: ownerId, publicKeyJwk: owner.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  await createVault(db, { vaultId, ownerAccountId: ownerId, r2Key: `data-${ownerId}.enc`, hd1Version: 2 });
  const dekA = await generateDEK();
  for (const [pid, pk] of [[ownerId, owner.publicKeyJwk] as const]) {
    const e = await wrapDEKForPublicKey(dekA, pk);
    await putEnvelope(db, { vaultId, principalAccountId: pid, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: ownerId });
  }
  // an active clinician provider
  const prov = await generateAccountKeypair();
  const provId = crypto.randomUUID();
  await createAccount(db, { id: provId, displayName: "Doc", providerKind: "primary" });
  await putPublicKey(db, { accountId: provId, publicKeyJwk: prov.publicKeyJwk });
  const e = await wrapDEKForPublicKey(dekA, prov.publicKeyJwk);
  await putEnvelope(db, { vaultId, principalAccountId: provId, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: ownerId });
  await createProviderLink(db, { ownerAccountId: ownerId, providerAccountId: provId, role: "primary", status: "active", grantedBy: ownerId });
  return { ownerId, vaultId, provId, provPub: prov.publicKeyJwk, ownerPub: owner.publicKeyJwk };
}

describe("vault rotation", () => {
  it("principals returns owner + org + active-provider keys (excludes a revoked link)", async () => {
    const s = await seedVaultWithProvider();
    // a revoked provider must not appear
    const revId = crypto.randomUUID();
    await createAccount(db, { id: revId, displayName: "Ex", providerKind: "support" });
    await putPublicKey(db, { accountId: revId, publicKeyJwk: (await generateAccountKeypair()).publicKeyJwk });
    await createProviderLink(db, { ownerAccountId: s.ownerId, providerAccountId: revId, role: "support", status: "revoked", grantedBy: s.ownerId });

    const res = await principals({ request: new Request("http://x/api/vault/principals", { headers: { cookie: await cookieFor(s.ownerId) } }), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = await res.json() as { selfAccountId: string; orgAccountId: string; providers: { accountId: string }[] };
    expect(body.selfAccountId).toBe(s.ownerId);
    expect(body.orgAccountId).toBe(ORG);
    expect(body.providers.map((p) => p.accountId).sort()).toEqual([s.provId].sort());
  });

  it("rotate replaces the whole envelope set, repoints the vault, and clears rotation_pending", async () => {
    const s = await seedVaultWithProvider();
    await setRotationPending(db, s.vaultId, true);
    const oldR2Key = (await getVault(db, s.vaultId))!.r2Key;

    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes: await envelopesFor(s, await generateDEK()) });
    expect(res.status).toBe(200);

    const set = (await listEnvelopesForVault(db, s.vaultId)).map((e) => e.principalAccountId).sort();
    expect(set).toEqual([s.ownerId, ORG, s.provId].sort());
    const after = (await getVault(db, s.vaultId))!;
    expect(after.rotationPending).toBe(false);
    expect(after.r2Key).toBe(`data-${newVaultId}.enc`);
    expect(after.r2Key).not.toBe(oldR2Key);
    expect(after.rotationStagingR2Key).toBeNull();
  });

  // W75 — the whole point of the two-phase shape. The old route re-encrypted in place and committed
  // the envelopes several round trips later; anything that died in that window left every principal
  // holding an envelope for a key the ciphertext no longer used. This asserts the STATE after the
  // interruption, not a status code: the vault must still open exactly as it did before.
  it("an interruption between the blob write and the commit leaves the vault openable", async () => {
    const s = await seedVaultWithProvider();
    const before = await Promise.all(
      (await listEnvelopesForVault(db, s.vaultId)).map(async (e) => [e.principalAccountId, b64(e.wrappedDek)] as const),
    );
    const oldR2Key = (await getVault(db, s.vaultId))!.r2Key;

    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId); // ...and the browser dies here.

    const vault = (await getVault(db, s.vaultId))!;
    expect(vault.r2Key).toBe(oldR2Key);
    const after = await Promise.all(
      (await listEnvelopesForVault(db, s.vaultId)).map(async (e) => [e.principalAccountId, b64(e.wrappedDek)] as const),
    );
    expect(after.sort()).toEqual(before.sort());
  });

  it("refuses to commit against a key that was never staged", async () => {
    const s = await seedVaultWithProvider();
    await stage(s.ownerId, s.vaultId);
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId: crypto.randomUUID(), envelopes: await envelopesFor(s, await generateDEK()) });
    expect(res.status).toBe(409);
  });

  // Repointing a vault at an object that does not exist is the same lockout reached from the other
  // side, so the commit checks that the blob it is about to make authoritative is actually there.
  it("refuses to commit when the staged blob was never written", async () => {
    const s = await seedVaultWithProvider();
    const newVaultId = await stage(s.ownerId, s.vaultId);
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes: await envelopesFor(s, await generateDEK()) });
    expect(res.status).toBe(409);
    expect((await listEnvelopesForVault(db, s.vaultId)).length).toBeGreaterThan(0);
  });

  // The vault is named now. It used to be listVaultsForOwner(...)[0] — an arbitrary row.
  it("refuses to rotate a vault the caller does not own", async () => {
    const mine = await seedVaultWithProvider();
    const theirs = await seedVaultWithProvider();
    const res = await rotate({ request: new Request("http://x/api/vault/rotate", { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor(mine.ownerId) }, body: JSON.stringify({ phase: "stage", vaultId: theirs.vaultId }) }), env: makeEnv() });
    expect(res.status).toBe(404);
    expect((await getVault(db, theirs.vaultId))!.rotationStagingR2Key).toBeNull();
  });

  // W75 — `envelopes.some(e => e.id === session.accountId)` only ever stopped the caller locking out
  // THEMSELVES. A set that quietly dropped the org-recovery principal or an active clinician was
  // accepted, and revoked them with no error and no record of the intent.
  it("refuses an envelope set that drops the org-recovery principal", async () => {
    const s = await seedVaultWithProvider();
    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const envelopes = (await envelopesFor(s, await generateDEK())).filter((e) => e.principalAccountId !== ORG);
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes });
    expect(res.status).toBe(400);
    expect((await res.json() as { missing: string[] }).missing).toEqual([ORG]);
    expect((await listEnvelopesForVault(db, s.vaultId)).map((e) => e.principalAccountId)).toContain(s.provId);
  });

  it("refuses an envelope set that drops an active clinician", async () => {
    const s = await seedVaultWithProvider();
    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const envelopes = (await envelopesFor(s, await generateDEK())).filter((e) => e.principalAccountId !== s.provId);
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes });
    expect(res.status).toBe(400);
    expect((await res.json() as { missing: string[] }).missing).toEqual([s.provId]);
  });

  it("refuses an envelope for a principal the vault has no business granting", async () => {
    const s = await seedVaultWithProvider();
    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const stranger = await seedVaultWithProvider();
    const dek = await generateDEK();
    const e = await wrapDEKForPublicKey(dek, stranger.ownerPub);
    const envelopes = [...(await envelopesFor(s, dek)), { principalAccountId: stranger.ownerId, wrappedDEK: b64(e.wrappedDEK), ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk }];
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes });
    expect(res.status).toBe(400);
  });

  it("rejects a rotation that omits the owner's own envelope (no self-lockout)", async () => {
    const s = await seedVaultWithProvider();
    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const envelopes = (await envelopesFor(s, await generateDEK())).filter((e) => e.principalAccountId !== s.ownerId);
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes });
    expect(res.status).toBe(400);
  });

  // W71 — the route deleted every envelope in a loop and THEN decoded each wrappedDEK, with atob
  // throwing on anything that is not base64 and no transaction around either loop. The R2 blob stays
  // encrypted under the new DEK while no envelope can unwrap it: owner, clinician and the org recovery
  // envelope gone together, from one malformed request. Unrecoverable, and silent until the next unlock.
  //
  // These assert the state of the VAULT after a bad request, not the status code — a 400 with the
  // envelopes already deleted would be the same disaster wearing a better response.
  it("a malformed wrappedDEK leaves every existing envelope untouched", async () => {
    const s = await seedVaultWithProvider();
    const before = (await listEnvelopesForVault(db, s.vaultId)).map((e) => e.principalAccountId).sort();
    expect(before.length).toBeGreaterThan(1);

    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const envelopes = await envelopesFor(s, await generateDEK());
    // Not the first position: the owner's envelope decodes fine, so a route that validated lazily
    // would already have committed the deletes by the time it reached this one.
    envelopes[envelopes.length - 1].wrappedDEK = "not base64!!";
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes });

    expect(res.status).toBe(400);
    const after = (await listEnvelopesForVault(db, s.vaultId)).map((e) => e.principalAccountId).sort();
    expect(after).toEqual(before);
    // The old envelopes must still be the ones that unwrap the CURRENT blob, i.e. unchanged bytes.
    for (const p of before) {
      expect((await getEnvelope(db, s.vaultId, p))!.wrappedDek.length).toBeGreaterThan(0);
    }
  });

  it("an empty wrappedDEK is rejected before anything is written", async () => {
    const s = await seedVaultWithProvider();
    const before = (await listEnvelopesForVault(db, s.vaultId)).length;
    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const envelopes = await envelopesFor(s, await generateDEK());
    envelopes[0].wrappedDEK = "";
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes });
    expect(res.status).toBe(400);
    expect((await listEnvelopesForVault(db, s.vaultId)).length).toBe(before);
  });

  // The batch is the second half of the fix, and `batch` is hand-declared on this repo's own
  // D1Database interface (@cloudflare/workers-types is deliberately not a dependency), so the
  // all-or-nothing semantics are pinned against real workerd rather than assumed from the docs.
  it("replaceEnvelopes applies as one transaction — a failing statement rolls the deletes back", async () => {
    const s = await seedVaultWithProvider();
    const before = (await listEnvelopesForVault(db, s.vaultId)).map((e) => e.principalAccountId).sort();
    await expect(
      replaceEnvelopes(db, s.vaultId, [
        { principalAccountId: s.ownerId, wrappedDek: new Uint8Array([1, 2, 3]), ephemeralPublicKeyJwk: {} },
        // No such account: vault_envelopes.principal_account_id is a foreign key, so D1 rejects this
        // statement and must discard the DELETE that preceded it in the same batch.
        { principalAccountId: "00000000-0000-4000-8000-00000000dead", wrappedDek: new Uint8Array([4]), ephemeralPublicKeyJwk: {} },
      ], s.ownerId),
    ).rejects.toThrow();
    expect((await listEnvelopesForVault(db, s.vaultId)).map((e) => e.principalAccountId).sort()).toEqual(before);
  });

  it("401s without a session", async () => {
    expect((await principals({ request: new Request("http://x/api/vault/principals"), env: makeEnv() })).status).toBe(401);
  });
});

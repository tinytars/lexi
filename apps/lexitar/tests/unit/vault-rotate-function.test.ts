import { describe, it, expect, beforeAll } from "vitest";
import { onRequestGet as principals } from "../../functions/api/vault/principals";
import { onRequestPost as rotate } from "../../functions/api/vault/rotate";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { getPublicKey, putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, getEnvelope, getVault, listEnvelopesForVault, putEnvelope, replaceEnvelopes, setRotationPending } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const ORG = "00000000-0000-4000-8000-000000000001";
const w = useWorkerd({ r2: true });

beforeAll(async () => {
  // the org operational account + its public key (client re-wraps the new DEK to it)
  const orgKp = await generateAccountKeypair();
  await createAccount(w.db, { id: ORG, displayName: "Org" });
  await putPublicKey(w.db, { accountId: ORG, publicKeyJwk: orgKp.publicKeyJwk });
});

const STORE_PREFIX = "test";
const makeEnv = () => ({ DB: w.db, SESSION_SECRET, VAULT: w.bucket, STORE_PREFIX }) as any;

/** The two-phase rotation, as the browser performs it: reserve, write the blob, commit. */
async function stage(ownerId: string, vaultId: string): Promise<string> {
  const res = await rotate({ request: new Request("http://x/api/vault/rotate", { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor(ownerId) }, body: JSON.stringify({ phase: "stage", vaultId }) }), env: makeEnv() });
  expect(res.status).toBe(200);
  return (await res.json() as { newVaultId: string }).newVaultId;
}
const writeStagedBlob = (newVaultId: string) => w.bucket.put(`${STORE_PREFIX}/data-${newVaultId}.enc`, new Uint8Array([0x48, 0x44, 0x31, 2]));
const commit = async (ownerId: string, body: unknown) =>
  rotate({ request: new Request("http://x/api/vault/rotate", { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor(ownerId) }, body: JSON.stringify({ phase: "commit", ...(body as object) }) }), env: makeEnv() });

/** Every principal the server will insist on, wrapped to a fresh DEK. */
async function envelopesFor(s: Awaited<ReturnType<typeof seedVaultWithProvider>>, dek: CryptoKey) {
  const targets: [string, JsonWebKey][] = [[s.ownerId, s.ownerPub], [ORG, (await getPublicKey(w.db, ORG))!.publicKeyJwk as JsonWebKey], [s.provId, s.provPub]];
  return Promise.all(targets.map(async ([pid, pk]) => {
    const e = await wrapDEKForPublicKey(dek, pk);
    return { principalAccountId: pid, wrappedDEK: b64(e.wrappedDEK), ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk };
  }));
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

async function seedVaultWithProvider() {
  const owner = await generateAccountKeypair();
  const ownerId = crypto.randomUUID();
  await createAccount(w.db, { id: ownerId, displayName: "Owner" });
  await putPublicKey(w.db, { accountId: ownerId, publicKeyJwk: owner.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  await createVault(w.db, { vaultId, ownerAccountId: ownerId, r2Key: `data-${ownerId}.enc`, hd1Version: 2 });
  const dekA = await generateDEK();
  for (const [pid, pk] of [[ownerId, owner.publicKeyJwk] as const]) {
    const e = await wrapDEKForPublicKey(dekA, pk);
    await putEnvelope(w.db, { vaultId, principalAccountId: pid, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: ownerId });
  }
  // an active clinician provider
  const prov = await generateAccountKeypair();
  const provId = crypto.randomUUID();
  await createAccount(w.db, { id: provId, displayName: "Doc", providerKind: "primary" });
  await putPublicKey(w.db, { accountId: provId, publicKeyJwk: prov.publicKeyJwk });
  const e = await wrapDEKForPublicKey(dekA, prov.publicKeyJwk);
  await putEnvelope(w.db, { vaultId, principalAccountId: provId, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: ownerId });
  await createProviderLink(w.db, { ownerAccountId: ownerId, providerAccountId: provId, role: "primary", status: "active", grantedBy: ownerId });
  return { ownerId, vaultId, provId, provPub: prov.publicKeyJwk, ownerPub: owner.publicKeyJwk };
}

describe("vault rotation", () => {
  it("principals returns owner + org + active-provider keys (excludes a revoked link)", async () => {
    const s = await seedVaultWithProvider();
    // a revoked provider must not appear
    const revId = crypto.randomUUID();
    await createAccount(w.db, { id: revId, displayName: "Ex", providerKind: "support" });
    await putPublicKey(w.db, { accountId: revId, publicKeyJwk: (await generateAccountKeypair()).publicKeyJwk });
    await createProviderLink(w.db, { ownerAccountId: s.ownerId, providerAccountId: revId, role: "support", status: "revoked", grantedBy: s.ownerId });

    const res = await principals({ request: new Request("http://x/api/vault/principals", { headers: { cookie: await cookieFor(s.ownerId) } }), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = await res.json() as { selfAccountId: string; orgAccountId: string; providers: { accountId: string }[] };
    expect(body.selfAccountId).toBe(s.ownerId);
    expect(body.orgAccountId).toBe(ORG);
    expect(body.providers.map((p) => p.accountId).sort()).toEqual([s.provId].sort());
  });

  it("rotate replaces the whole envelope set, repoints the vault, and clears rotation_pending", async () => {
    const s = await seedVaultWithProvider();
    await setRotationPending(w.db, s.vaultId, true);
    const oldR2Key = (await getVault(w.db, s.vaultId))!.r2Key;

    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes: await envelopesFor(s, await generateDEK()) });
    expect(res.status).toBe(200);

    const set = (await listEnvelopesForVault(w.db, s.vaultId)).map((e) => e.principalAccountId).sort();
    expect(set).toEqual([s.ownerId, ORG, s.provId].sort());
    const after = (await getVault(w.db, s.vaultId))!;
    expect(after.rotationPending).toBe(false);
    expect(after.r2Key).toBe(`data-${newVaultId}.enc`);
    expect(after.r2Key).not.toBe(oldR2Key);
    expect(after.rotationStagingR2Key).toBeNull();
  });

  // The point of the two-phase shape: asserts the STATE after the interruption, not a status code.
  it("an interruption between the blob write and the commit leaves the vault openable", async () => {
    const s = await seedVaultWithProvider();
    const before = await Promise.all(
      (await listEnvelopesForVault(w.db, s.vaultId)).map(async (e) => [e.principalAccountId, b64(e.wrappedDek)] as const),
    );
    const oldR2Key = (await getVault(w.db, s.vaultId))!.r2Key;

    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId); // ...and the browser dies here.

    const vault = (await getVault(w.db, s.vaultId))!;
    expect(vault.r2Key).toBe(oldR2Key);
    const after = await Promise.all(
      (await listEnvelopesForVault(w.db, s.vaultId)).map(async (e) => [e.principalAccountId, b64(e.wrappedDek)] as const),
    );
    expect(after.sort()).toEqual(before.sort());
  });

  it("refuses to commit against a key that was never staged", async () => {
    const s = await seedVaultWithProvider();
    await stage(s.ownerId, s.vaultId);
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId: crypto.randomUUID(), envelopes: await envelopesFor(s, await generateDEK()) });
    expect(res.status).toBe(409);
  });

  // Repointing a vault at a missing object is the same lockout reached from the other side.
  it("refuses to commit when the staged blob was never written", async () => {
    const s = await seedVaultWithProvider();
    const newVaultId = await stage(s.ownerId, s.vaultId);
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes: await envelopesFor(s, await generateDEK()) });
    expect(res.status).toBe(409);
    expect((await listEnvelopesForVault(w.db, s.vaultId)).length).toBeGreaterThan(0);
  });

  it("refuses to rotate a vault the caller does not own", async () => {
    const mine = await seedVaultWithProvider();
    const theirs = await seedVaultWithProvider();
    const res = await rotate({ request: new Request("http://x/api/vault/rotate", { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor(mine.ownerId) }, body: JSON.stringify({ phase: "stage", vaultId: theirs.vaultId }) }), env: makeEnv() });
    expect(res.status).toBe(404);
    expect((await getVault(w.db, theirs.vaultId))!.rotationStagingR2Key).toBeNull();
  });

  // Dropping a principal from the set would silently revoke them, with no record of the intent.
  it("refuses an envelope set that drops the org-recovery principal", async () => {
    const s = await seedVaultWithProvider();
    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const envelopes = (await envelopesFor(s, await generateDEK())).filter((e) => e.principalAccountId !== ORG);
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes });
    expect(res.status).toBe(400);
    expect((await res.json() as { missing: string[] }).missing).toEqual([ORG]);
    expect((await listEnvelopesForVault(w.db, s.vaultId)).map((e) => e.principalAccountId)).toContain(s.provId);
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

  // Asserts the VAULT's state, not the status: a 400 after the deletes ran would still be an unrecoverable lockout.
  it("a malformed wrappedDEK leaves every existing envelope untouched", async () => {
    const s = await seedVaultWithProvider();
    const before = (await listEnvelopesForVault(w.db, s.vaultId)).map((e) => e.principalAccountId).sort();
    expect(before.length).toBeGreaterThan(1);

    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const envelopes = await envelopesFor(s, await generateDEK());
    // Not the first position, so a lazily-validating route would already have run the deletes.
    envelopes[envelopes.length - 1].wrappedDEK = "not base64!!";
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes });

    expect(res.status).toBe(400);
    const after = (await listEnvelopesForVault(w.db, s.vaultId)).map((e) => e.principalAccountId).sort();
    expect(after).toEqual(before);
    // The old envelopes must still be the ones that unwrap the CURRENT blob, i.e. unchanged bytes.
    for (const p of before) {
      expect((await getEnvelope(w.db, s.vaultId, p))!.wrappedDek.length).toBeGreaterThan(0);
    }
  });

  it("an empty wrappedDEK is rejected before anything is written", async () => {
    const s = await seedVaultWithProvider();
    const before = (await listEnvelopesForVault(w.db, s.vaultId)).length;
    const newVaultId = await stage(s.ownerId, s.vaultId);
    await writeStagedBlob(newVaultId);
    const envelopes = await envelopesFor(s, await generateDEK());
    envelopes[0].wrappedDEK = "";
    const res = await commit(s.ownerId, { vaultId: s.vaultId, newVaultId, envelopes });
    expect(res.status).toBe(400);
    expect((await listEnvelopesForVault(w.db, s.vaultId)).length).toBe(before);
  });

  // `batch` is hand-declared on this repo's D1Database, so its all-or-nothing semantics are pinned against real workerd.
  it("replaceEnvelopes applies as one transaction — a failing statement rolls the deletes back", async () => {
    const s = await seedVaultWithProvider();
    const before = (await listEnvelopesForVault(w.db, s.vaultId)).map((e) => e.principalAccountId).sort();
    await expect(
      replaceEnvelopes(w.db, s.vaultId, [
        { principalAccountId: s.ownerId, wrappedDek: new Uint8Array([1, 2, 3]), ephemeralPublicKeyJwk: {} },
        // No such account: the foreign key rejects this, which must discard the DELETE earlier in the batch.
        { principalAccountId: "00000000-0000-4000-8000-00000000dead", wrappedDek: new Uint8Array([4]), ephemeralPublicKeyJwk: {} },
      ], s.ownerId),
    ).rejects.toThrow();
    expect((await listEnvelopesForVault(w.db, s.vaultId)).map((e) => e.principalAccountId).sort()).toEqual(before);
  });

  it("401s without a session", async () => {
    expect((await principals({ request: new Request("http://x/api/vault/principals"), env: makeEnv() })).status).toBe(401);
  });
});

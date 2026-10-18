// Holding an envelope is permission to READ. This file pins the one place that distinction has to be
// made: a support principal exists to be handed a time-boxed key so it can read a record, and the
// credential that sits on a disk for a week must not also be able to overwrite the record. Read access
// and write access were the same check until now, so the GET assertions here are as load-bearing as the
// PUT ones — a gate that closed writing by closing reading would have broken the feature it protects.
import { describe, it, expect } from "vitest";
import { onRequestPut as putVault, onRequestGet as getVault } from "../../functions/api/vault/[id]";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import type { ProviderKind } from "../../functions/_lib/identity-types";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";
import { hd1Blob } from "../support/blobs";

// Real R2, so the PUT either stores bytes or does not — a mocked bucket would let a refused write look
// identical to an accepted one.
const w = useWorkerd({ r2: true });

const makeEnv = () => ({
  DB: w.db,
  SESSION_SECRET,
  VAULT_TOKEN: "ops-token",
  STORE_PREFIX: "test",
  VAULT: w.bucket,
  ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
});

const keyFor = (urlId: string) => `test/data-${urlId}.enc`;
const distinctBlob = () => {
  const b = hd1Blob();
  crypto.getRandomValues(b.subarray(3));
  return b;
};

/** A patient with a vault, an owner envelope, and the DEK the principals below are handed. */
async function seedPatient() {
  const kp = await generateAccountKeypair();
  const ownerId = crypto.randomUUID();
  await createAccount(w.db, { id: ownerId, displayName: "Owner" });
  await putPublicKey(w.db, { accountId: ownerId, publicKeyJwk: kp.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  await createVault(w.db, { vaultId, ownerAccountId: ownerId, r2Key: `data-${vaultId}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const e = await wrapDEKForPublicKey(dek, kp.publicKeyJwk);
  await putEnvelope(w.db, { vaultId, principalAccountId: ownerId, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: ownerId });
  return { ownerId, vaultId, urlId: vaultId, dek };
}

/**
 * A principal the patient has granted: its own account, an envelope for the vault, and a live link.
 * The envelope is what the write path used to check, so every case below already passes that check —
 * which is the only way to test the one added after it.
 */
async function grantPrincipal(
  patient: Awaited<ReturnType<typeof seedPatient>>,
  kind: ProviderKind,
  role: "primary" | "support",
  expiresAt?: string,
) {
  const kp = await generateAccountKeypair();
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: "Principal", email: `${id}@clinic.test`, providerKind: kind });
  await putPublicKey(w.db, { accountId: id, publicKeyJwk: kp.publicKeyJwk });
  const e = await wrapDEKForPublicKey(patient.dek, kp.publicKeyJwk);
  await putEnvelope(w.db, {
    vaultId: patient.vaultId, principalAccountId: id,
    wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: patient.ownerId,
  });
  await createProviderLink(w.db, {
    ownerAccountId: patient.ownerId, providerAccountId: id, role, status: "active", grantedBy: patient.ownerId,
    ...(expiresAt ? { expiresAt } : {}),
  });
  return { id };
}

const put = async (urlId: string, accountId: string, precondition: Record<string, string> = { "If-None-Match": "*" }) =>
  putVault({
    request: new Request(`http://x/api/vault/${urlId}`, {
      method: "PUT",
      headers: { ...precondition, cookie: await cookieFor(accountId) },
      body: distinctBlob(),
    }),
    env: makeEnv(),
    params: { id: urlId },
  } as any);

const get = async (urlId: string, accountId: string) =>
  getVault({
    request: new Request(`http://x/api/vault/${urlId}`, { headers: { cookie: await cookieFor(accountId) } }),
    env: makeEnv(),
    params: { id: urlId },
  } as any);

const IN_A_WEEK = () => new Date(Date.now() + 168 * 3600_000).toISOString();

describe("PUT /api/vault/[id] — who may write, not merely who may read", () => {
  it("lets the owner write their own record", async () => {
    const p = await seedPatient();
    expect((await put(p.urlId, p.ownerId)).status).toBe(204);
  });

  it("lets a clinician the patient has taken on write", async () => {
    // The case a blanket owner-only rule would have broken: a clinician correcting a record is the
    // existing feature, and it is why the gate asks for a `primary` link rather than for ownership.
    const p = await seedPatient();
    const doc = await grantPrincipal(p, "primary", "primary");
    expect((await put(p.urlId, doc.id)).status).toBe(204);
  });

  it("refuses a support principal holding a live seven-day grant", async () => {
    const p = await seedPatient();
    const agent = await grantPrincipal(p, "support", "support", IN_A_WEEK());
    const res = await put(p.urlId, agent.id);
    expect(res.status).toBe(403);
    expect((await res.json() as any).errorCode).toBe("read_only_principal");
    // Nothing was written, which is the property — a 403 with the bytes stored would be worse than a 204.
    expect(await w.bucket.get(keyFor(p.urlId))).toBeNull();
  });

  it("still lets that support principal READ the record it was granted", async () => {
    // The whole feature: the seven-day credential exports a record. If this went 403 too, the gate above
    // would be indistinguishable from revoking the grant.
    const p = await seedPatient();
    const agent = await grantPrincipal(p, "support", "support", IN_A_WEEK());
    expect((await put(p.urlId, p.ownerId)).status).toBe(204);
    expect((await get(p.urlId, agent.id)).status).toBe(200);
  });

  it("leaves a closed window to the gate that already enforces it, one layer up", async () => {
    // A lapsed grant never reaches the new check: `getEnvelope` resolves a non-owner principal through
    // its live link and refuses an expired one first, with the no-access refusal rather than the
    // read-only one. Pinned because the layering is the safety property — the write gate asks only about
    // ROLE, so it would be wrong to later reorder it ahead of the check that asks about TIME.
    const p = await seedPatient();
    const agent = await grantPrincipal(p, "support", "support", new Date(Date.now() - 1000).toISOString());
    const res = await put(p.urlId, agent.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "no access to this vault" });
  });
});

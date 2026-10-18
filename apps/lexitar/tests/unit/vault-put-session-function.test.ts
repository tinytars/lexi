import { describe, it, expect } from "vitest";
import { onRequestPut as putVault } from "../../functions/api/vault/[id]";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";
import { hd1Blob } from "../support/blobs";

const VAULT_TOKEN = "ops-token";
// Real R2, so etags and onlyIf preconditions are workerd's. Every test seeds a fresh vault id, so keys never collide.
const w = useWorkerd({ r2: true });

const makeEnv = () => ({
  DB: w.db,
  SESSION_SECRET,
  VAULT_TOKEN,
  STORE_PREFIX: "test",
  VAULT: w.bucket,
  ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
});
const keyFor = (urlId: string) => `test/data-${urlId}.enc`;
const storedBytes = async (key: string) => new Uint8Array(await (await w.bucket.get(key))!.arrayBuffer());
// R2's etag is the content's MD5, so each save needs distinct bytes for its version to move on.
const distinctBlob = () => {
  const b = hd1Blob();
  crypto.getRandomValues(b.subarray(3));
  return b;
};

// Seed a patient-owned vault whose r2_key is data-<id>.enc, so the PUT route (params.id → data-<id>.enc)
// resolves it. Returns the id used in the URL + the owner account id.
async function seedVault() {
  const owner = await generateAccountKeypair();
  const ownerId = crypto.randomUUID();
  await createAccount(w.db, { id: ownerId, displayName: "Owner" });
  await putPublicKey(w.db, { accountId: ownerId, publicKeyJwk: owner.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  const urlId = vaultId; // r2_key = data-<vaultId>.enc → route id = vaultId
  await createVault(w.db, { vaultId, ownerAccountId: ownerId, r2Key: `data-${urlId}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const env0 = await wrapDEKForPublicKey(dek, owner.publicKeyJwk);
  await putEnvelope(w.db, {
    vaultId,
    principalAccountId: ownerId,
    wrappedDek: env0.wrappedDEK,
    ephemeralPublicKeyJwk: env0.ephemeralPublicKeyJwk,
    createdBy: ownerId,
  });
  return { urlId, ownerId };
}

async function put(
  id: string,
  auth: { bearer?: string; accountId?: string },
  // Each vault starts empty, so create-only is the realistic default; `null` omits the precondition.
  precondition: Record<string, string> | null = { "If-None-Match": "*" },
): Promise<Response> {
  const headers: Record<string, string> = { ...precondition };
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.accountId) headers.cookie = await cookieFor(auth.accountId);
  return putVault({
    request: new Request(`http://x/api/vault/${id}`, { method: "PUT", headers, body: distinctBlob() }),
    env: makeEnv(),
    params: { id },
  });
}

describe("PUT /api/vault/[id] auth", () => {
  it("accepts the ops bearer and stores the blob", async () => {
    const { urlId } = await seedVault();
    const res = await put(urlId, { bearer: VAULT_TOKEN });
    expect(res.status).toBe(204);
    expect(await w.bucket.get(keyFor(urlId))).not.toBeNull();
  });

  it("accepts an owner session (has an envelope for the vault)", async () => {
    const { urlId, ownerId } = await seedVault();
    const res = await put(urlId, { accountId: ownerId });
    expect(res.status).toBe(204);
  });

  it("403s a valid session with no envelope for the vault", async () => {
    const { urlId } = await seedVault();
    const stranger = crypto.randomUUID();
    await createAccount(w.db, { id: stranger, displayName: "Stranger" });
    const res = await put(urlId, { accountId: stranger });
    expect(res.status).toBe(403);
  });

  it("401s with no bearer and no session", async () => {
    const { urlId } = await seedVault();
    const res = await put(urlId, {});
    expect(res.status).toBe(401);
  });

  it("404s a session when the vault r2_key is unknown", async () => {
    const stranger = crypto.randomUUID();
    await createAccount(w.db, { id: stranger, displayName: "Ghost" });
    const res = await put("does-not-exist", { accountId: stranger });
    expect(res.status).toBe(404);
  });
});

// A write carries the WHOLE vault, so a lost race loses every edit since unlock; the precondition is
// required on the session path because an optional guard silently does not apply.
describe("PUT /api/vault/[id] — optimistic concurrency", () => {
  it("428s a browser save that states no version", async () => {
    const { urlId, ownerId } = await seedVault();
    const res = await put(urlId, { accountId: ownerId }, null);
    expect(res.status).toBe(428);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("If-Match") });
  });

  // The ops bearer is a different contract: no browser, no concurrent tab, and the e2e harness uses it.
  it("still accepts the ops bearer with no precondition", async () => {
    const { urlId } = await seedVault();
    const res = await put(urlId, { bearer: VAULT_TOKEN }, null);
    expect(res.status).toBe(204);
  });

  it("accepts a create-only save and returns the new version", async () => {
    const { urlId, ownerId } = await seedVault();
    const res = await put(urlId, { accountId: ownerId }, { "If-None-Match": "*" });
    expect(res.status).toBe(204);
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("412s a save whose version is stale, and does NOT overwrite", async () => {
    const { urlId, ownerId } = await seedVault();
    const key = keyFor(urlId);

    const created = await put(urlId, { accountId: ownerId }, { "If-None-Match": "*" });
    const firstEtag = created.headers.get("etag")!;

    // Someone else saves — the version moves on.
    const second = await put(urlId, { accountId: ownerId }, { "If-Match": firstEtag });
    expect(second.status).toBe(204);
    const winnerBytes = await storedBytes(key);

    // Our tab still holds the version it loaded at unlock.
    const stale = await put(urlId, { accountId: ownerId }, { "If-Match": firstEtag });
    expect(stale.status).toBe(412);
    // The refusal hands back the CURRENT version, so the client resolves in one round trip not two.
    expect(stale.headers.get("etag")).toBeTruthy();
    expect(stale.headers.get("etag")).not.toBe(firstEtag);
    // And the winner's bytes are untouched — the whole point.
    expect(await storedBytes(key)).toEqual(winnerBytes);
    expect((await w.bucket.get(key))!.etag).toBe(second.headers.get("etag"));
  });

  it("a create-only save refuses to clobber a vault that already exists", async () => {
    const { urlId, ownerId } = await seedVault();
    await put(urlId, { accountId: ownerId }, { "If-None-Match": "*" });
    const again = await put(urlId, { accountId: ownerId }, { "If-None-Match": "*" });
    expect(again.status).toBe(412);
  });

  it("accepts a quoted If-Match, as a browser echoing an ETag header sends it", async () => {
    const { urlId, ownerId } = await seedVault();
    const created = await put(urlId, { accountId: ownerId }, { "If-None-Match": "*" });
    const etag = created.headers.get("etag")!;
    const res = await put(urlId, { accountId: ownerId }, { "If-Match": `"${etag}"` });
    expect(res.status).toBe(204);
  });
});

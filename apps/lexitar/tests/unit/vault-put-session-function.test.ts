import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestPut as putVault } from "../../functions/api/vault/[id]";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { signSession } from "../../functions/_lib/session";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

let mf: Miniflare;
let db: any; // D1Database

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-vault-put" },
  });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
});

afterAll(async () => {
  await mf.dispose();
});

const SECRET = "test-secret";
const VAULT_TOKEN = "ops-token";

let etagSeq = 0;
const etags = new Map<string, string>();

function makeEnv(store: Map<string, Uint8Array>) {
  return {
    DB: db,
    SESSION_SECRET: SECRET,
    VAULT_TOKEN,
    STORE_PREFIX: "test",
    // W70 — models etags + conditional writes, like the fake in vault-function.test.ts. The store here
    // always starts empty, so a create-only precondition (If-None-Match: *) is the realistic one.
    VAULT: {
      put: async (k: string, v: Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
        const current = etags.get(k);
        const cond = options?.onlyIf;
        if (cond?.etagMatches !== undefined && cond.etagMatches !== current) return null;
        if (cond?.etagDoesNotMatch === "*" && current !== undefined) return null;
        store.set(k, new Uint8Array(v));
        const next = `etag-${++etagSeq}`;
        etags.set(k, next);
        return { etag: next };
      },
      get: async (k: string) => (store.has(k) ? { body: new Response(store.get(k)! as BodyInit).body!, etag: etags.get(k)! } : null),
      delete: async (k: string) => { store.delete(k); etags.delete(k); },
    },
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
  };
}

// A minimal valid HD1 blob: magic "HD1" + version + padding to MIN_BYTES (32).
const hd1Blob = () => {
  const b = new Uint8Array(32);
  b[0] = 0x48; b[1] = 0x44; b[2] = 0x31; b[3] = 2;
  return b;
};

// Seed a patient-owned vault whose r2_key is data-<id>.enc, so the PUT route (params.id → data-<id>.enc)
// resolves it. Returns the id used in the URL + the owner account id.
async function seedVault() {
  const owner = await generateAccountKeypair();
  const ownerId = crypto.randomUUID();
  await createAccount(db, { id: ownerId, displayName: "Owner" });
  await putPublicKey(db, { accountId: ownerId, publicKeyJwk: owner.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  const urlId = vaultId; // r2_key = data-<vaultId>.enc → route id = vaultId
  await createVault(db, { vaultId, ownerAccountId: ownerId, r2Key: `data-${urlId}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const env0 = await wrapDEKForPublicKey(dek, owner.publicKeyJwk);
  await putEnvelope(db, {
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
  store: Map<string, Uint8Array>,
  // W70 — the browser must state which version it replaces. These stores start empty, so the realistic
  // default is create-only. `null` omits it entirely, to exercise the required-precondition guard.
  precondition: Record<string, string> | null = { "If-None-Match": "*" },
): Promise<Response> {
  const headers: Record<string, string> = { ...precondition };
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.accountId) headers.cookie = `hd_session=${await signSession({ SESSION_SECRET: SECRET }, auth.accountId)}`;
  return putVault({
    request: new Request(`http://x/api/vault/${id}`, { method: "PUT", headers, body: hd1Blob() }),
    env: makeEnv(store),
    params: { id },
  });
}

describe("PUT /api/vault/[id] auth", () => {
  it("accepts the ops bearer and stores the blob", async () => {
    const { urlId } = await seedVault();
    const store = new Map<string, Uint8Array>();
    const res = await put(urlId, { bearer: VAULT_TOKEN }, store);
    expect(res.status).toBe(204);
    expect(store.has(`test/data-${urlId}.enc`)).toBe(true);
  });

  it("accepts an owner session (has an envelope for the vault)", async () => {
    const { urlId, ownerId } = await seedVault();
    const res = await put(urlId, { accountId: ownerId }, new Map());
    expect(res.status).toBe(204);
  });

  it("403s a valid session with no envelope for the vault", async () => {
    const { urlId } = await seedVault();
    const stranger = crypto.randomUUID();
    await createAccount(db, { id: stranger, displayName: "Stranger" });
    const res = await put(urlId, { accountId: stranger }, new Map());
    expect(res.status).toBe(403);
  });

  it("401s with no bearer and no session", async () => {
    const { urlId } = await seedVault();
    const res = await put(urlId, {}, new Map());
    expect(res.status).toBe(401);
  });

  it("404s a session when the vault r2_key is unknown", async () => {
    const stranger = crypto.randomUUID();
    await createAccount(db, { id: stranger, displayName: "Ghost" });
    const res = await put("does-not-exist", { accountId: stranger }, new Map());
    expect(res.status).toBe(404);
  });
});

// W70 — the precondition is REQUIRED on the browser path.
//
// Two tabs, or a patient and the clinician the envelope model explicitly lets in, each held the vault
// they loaded at unlock and overwrote each other. Because a write carries the WHOLE vault, the loser
// did not lose a field — it lost every edit since unlock, and was shown "✓ saved" while it happened.
//
// Required, not optional, and only on the session path: an optional guard is a guard that silently
// does not apply, and silence is the entire bug. The ops-bearer path stays unconditional because the
// real ops scripts bypass this Function altogether (scripts/vault-sync.ts:11 uses direct bucket
// access), so requiring it there would gain nothing and break the e2e harness token.
describe("PUT /api/vault/[id] — optimistic concurrency", () => {
  it("428s a browser save that states no version", async () => {
    const { urlId, ownerId } = await seedVault();
    const res = await put(urlId, { accountId: ownerId }, new Map(), null);
    expect(res.status).toBe(428);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("If-Match") });
  });

  // The ops bearer is a different contract: no browser, no concurrent tab, and the e2e harness uses it.
  it("still accepts the ops bearer with no precondition", async () => {
    const { urlId } = await seedVault();
    const res = await put(urlId, { bearer: VAULT_TOKEN }, new Map(), null);
    expect(res.status).toBe(204);
  });

  it("accepts a create-only save and returns the new version", async () => {
    const { urlId, ownerId } = await seedVault();
    const res = await put(urlId, { accountId: ownerId }, new Map(), { "If-None-Match": "*" });
    expect(res.status).toBe(204);
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("412s a save whose version is stale, and does NOT overwrite", async () => {
    const { urlId, ownerId } = await seedVault();
    const store = new Map<string, Uint8Array>();
    const key = `test/data-${urlId}.enc`;

    const created = await put(urlId, { accountId: ownerId }, store, { "If-None-Match": "*" });
    const firstEtag = created.headers.get("etag")!;

    // Someone else saves — the version moves on.
    const second = await put(urlId, { accountId: ownerId }, store, { "If-Match": firstEtag });
    expect(second.status).toBe(204);
    const winnerBytes = new Uint8Array(store.get(key)!);

    // Our tab still holds the version it loaded at unlock.
    const stale = await put(urlId, { accountId: ownerId }, store, { "If-Match": firstEtag });
    expect(stale.status).toBe(412);
    // The refusal hands back the CURRENT version, so the client resolves in one round trip not two.
    expect(stale.headers.get("etag")).toBeTruthy();
    expect(stale.headers.get("etag")).not.toBe(firstEtag);
    // And the winner's bytes are untouched — the whole point.
    expect(new Uint8Array(store.get(key)!)).toEqual(winnerBytes);
  });

  it("a create-only save refuses to clobber a vault that already exists", async () => {
    const { urlId, ownerId } = await seedVault();
    const store = new Map<string, Uint8Array>();
    await put(urlId, { accountId: ownerId }, store, { "If-None-Match": "*" });
    const again = await put(urlId, { accountId: ownerId }, store, { "If-None-Match": "*" });
    expect(again.status).toBe(412);
  });

  it("accepts a quoted If-Match, as a browser echoing an ETag header sends it", async () => {
    const { urlId, ownerId } = await seedVault();
    const store = new Map<string, Uint8Array>();
    const created = await put(urlId, { accountId: ownerId }, store, { "If-None-Match": "*" });
    const etag = created.headers.get("etag")!;
    const res = await put(urlId, { accountId: ownerId }, store, { "If-Match": `"${etag}"` });
    expect(res.status).toBe(204);
  });
});

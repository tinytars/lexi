import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestGet } from "../../functions/api/vault/[id]";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { signSession } from "../../functions/_lib/session";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

// W44 P4 / §G — GET /api/vault/[id] now requires the ops bearer OR a session whose account holds an
// envelope for the vault. This exercises the session/envelope matrix against a real Miniflare D1.

let mf: Miniflare;
let db: any;

const SECRET = "test-secret";
const SLUG = "pab";

// HD1-prefixed blob so the served bytes look like a real encrypted slice.
function hd1(n = 40): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  b[0] = 0x48; b[1] = 0x44; b[2] = 0x31;
  for (let i = 3; i < n; i++) b[i] = (i * 7) & 0xff;
  return b;
}

function makeEnv() {
  const store = new Map<string, Uint8Array<ArrayBuffer>>();
  store.set(`dev/data-${SLUG}.enc`, hd1(64)); // pre-seeded blob
  return {
    store,
    DB: db,
    SESSION_SECRET: SECRET,
    VAULT_TOKEN: "t",
    STORE_PREFIX: "dev",
    VAULT: {
      get: async (k: string) => (store.has(k) ? { body: new Response(store.get(k)!).body! } : null),
      put: async (k: string, v: Uint8Array<ArrayBuffer>) => { store.set(k, new Uint8Array(v)); },
      delete: async (k: string) => { store.delete(k); },
    },
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
  };
}

let patientId: string;
let strangerId: string;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-vault-gate" } });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);

  const kp = await generateAccountKeypair();
  patientId = crypto.randomUUID();
  await createAccount(db, { id: patientId, displayName: "Pat" });
  await putPublicKey(db, { accountId: patientId, publicKeyJwk: kp.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  await createVault(db, { vaultId, ownerAccountId: patientId, r2Key: `data-${SLUG}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const env0 = await wrapDEKForPublicKey(dek, kp.publicKeyJwk);
  await putEnvelope(db, { vaultId, principalAccountId: patientId, wrappedDek: env0.wrappedDEK, ephemeralPublicKeyJwk: env0.ephemeralPublicKeyJwk, createdBy: patientId });

  strangerId = crypto.randomUUID();
  await createAccount(db, { id: strangerId, displayName: "Stranger" });
});

afterAll(async () => { await mf.dispose(); });

const get = (cookie?: string) =>
  onRequestGet({
    request: new Request(`http://x/api/vault/${SLUG}`, cookie ? { headers: { cookie } } : {}),
    env: makeEnv() as any,
    params: { id: SLUG },
  });

describe("GET /api/vault/:id — §G session/envelope gate", () => {
  it("401s without a bearer or session", async () => {
    expect((await get()).status).toBe(401);
  });

  it("403s for a session whose account has no envelope for the vault", async () => {
    const cookie = `hd_session=${await signSession({ SESSION_SECRET: SECRET }, strangerId)}`;
    expect((await get(cookie)).status).toBe(403);
  });

  it("200s (returns the blob) for a session whose account holds an envelope", async () => {
    const cookie = `hd_session=${await signSession({ SESSION_SECRET: SECRET }, patientId)}`;
    const res = await get(cookie);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())[0]).toBe(0x48); // "H" of HD1
  });

  it("200s via the ops bearer regardless of session", async () => {
    const res = await onRequestGet({
      request: new Request(`http://x/api/vault/${SLUG}`, { headers: { authorization: "Bearer t" } }),
      env: makeEnv() as any,
      params: { id: SLUG },
    });
    expect(res.status).toBe(200);
  });
});

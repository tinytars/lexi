import { describe, it, expect, beforeAll } from "vitest";
import { onRequestGet } from "../../functions/api/vault/[id]";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";
import { hd1Blob } from "../support/blobs";

// GET /api/vault/[id] requires the ops bearer OR a session whose account holds an envelope for the vault.
const SLUG = "pab";
const w = useWorkerd({ r2: true });

const makeEnv = () => ({
  DB: w.db,
  SESSION_SECRET,
  VAULT_TOKEN: "t",
  STORE_PREFIX: "dev",
  VAULT: w.bucket,
  ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
});

let patientId: string;
let strangerId: string;

beforeAll(async () => {
  await w.bucket.put(`dev/data-${SLUG}.enc`, hd1Blob(64));
  const kp = await generateAccountKeypair();
  patientId = crypto.randomUUID();
  await createAccount(w.db, { id: patientId, displayName: "Pat" });
  await putPublicKey(w.db, { accountId: patientId, publicKeyJwk: kp.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  await createVault(w.db, { vaultId, ownerAccountId: patientId, r2Key: `data-${SLUG}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const env0 = await wrapDEKForPublicKey(dek, kp.publicKeyJwk);
  await putEnvelope(w.db, { vaultId, principalAccountId: patientId, wrappedDek: env0.wrappedDEK, ephemeralPublicKeyJwk: env0.ephemeralPublicKeyJwk, createdBy: patientId });

  strangerId = crypto.randomUUID();
  await createAccount(w.db, { id: strangerId, displayName: "Stranger" });
});

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
    const cookie = await cookieFor(strangerId);
    expect((await get(cookie)).status).toBe(403);
  });

  it("200s (returns the blob) for a session whose account holds an envelope", async () => {
    const cookie = await cookieFor(patientId);
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

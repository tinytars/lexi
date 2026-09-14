import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestGet as orgKey } from "../../functions/api/vault/org-key";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { ORG_ACCOUNT_ID } from "../../functions/_lib/org";
import { generateAccountKeypair } from "@tinytars/vault/crypto";

// W55 P4 — GET /api/vault/org-key is unauthenticated by design (signup has no session yet), so
// the only two states worth covering are "no session, key present" and "key row absent".
let mf: Miniflare;
let db: any;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-org-key" } });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
});
afterAll(async () => { await mf.dispose(); });

const makeEnv = () => ({ DB: db }) as any;
const getOrgKey = () => orgKey({ request: new Request("http://x/api/vault/org-key"), env: makeEnv() });

describe("GET /api/vault/org-key", () => {
  it("500s with missing_org_key when the org public key row is absent", async () => {
    const res = await getOrgKey();
    expect(res.status).toBe(500);
  });

  it("returns {orgAccountId, orgPublicKeyJwk} with no session once the org key exists", async () => {
    await createAccount(db, { id: ORG_ACCOUNT_ID, displayName: "Org" });
    const { publicKeyJwk } = await generateAccountKeypair();
    await putPublicKey(db, { accountId: ORG_ACCOUNT_ID, publicKeyJwk });

    const res = await getOrgKey();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgAccountId: string; orgPublicKeyJwk: unknown };
    expect(body.orgAccountId).toBe(ORG_ACCOUNT_ID);
    expect(body.orgPublicKeyJwk).toMatchObject(publicKeyJwk as Record<string, unknown>);
  });
});

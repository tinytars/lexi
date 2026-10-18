import { describe, it, expect } from "vitest";
import { onRequestGet as orgKey } from "../../functions/api/vault/org-key";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { ORG_ACCOUNT_ID } from "../../functions/_lib/org";
import { generateAccountKeypair } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";

// Unauthenticated by design (signup has no session yet), so only "key present" and "key absent" matter.
const w = useWorkerd();
const makeEnv = () => ({ DB: w.db }) as any;
const getOrgKey = () => orgKey({ request: new Request("http://x/api/vault/org-key"), env: makeEnv() });

describe("GET /api/vault/org-key", () => {
  it("500s with missing_org_key when the org public key row is absent", async () => {
    const res = await getOrgKey();
    expect(res.status).toBe(500);
  });

  it("returns {orgAccountId, orgPublicKeyJwk} with no session once the org key exists", async () => {
    await createAccount(w.db, { id: ORG_ACCOUNT_ID, displayName: "Org" });
    const { publicKeyJwk } = await generateAccountKeypair();
    await putPublicKey(w.db, { accountId: ORG_ACCOUNT_ID, publicKeyJwk });

    const res = await getOrgKey();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgAccountId: string; orgPublicKeyJwk: unknown };
    expect(body.orgAccountId).toBe(ORG_ACCOUNT_ID);
    expect(body.orgPublicKeyJwk).toMatchObject(publicKeyJwk as Record<string, unknown>);
  });
});

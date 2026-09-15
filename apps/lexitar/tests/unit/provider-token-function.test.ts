import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestGet } from "../../functions/api/provider-token";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { signSession } from "../../functions/_lib/session";

let mf: Miniflare;
let db: any; // D1Database
let providerId: string;
let patientId: string;

const SECRET = "test-secret";
const PROVIDER_TOKEN = "distinct-secret-xyz";

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-provider-token" },
  });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
  providerId = crypto.randomUUID();
  patientId = crypto.randomUUID();
  await createAccount(db, { id: providerId, displayName: "Prov", providerKind: "primary" });
  await createAccount(db, { id: patientId, displayName: "Pat" });
});

afterAll(async () => {
  await mf.dispose();
});

async function call(accountId: string | null, token = PROVIDER_TOKEN, bogus = false): Promise<Response> {
  const headers: Record<string, string> = {};
  if (accountId) headers.cookie = `hd_session=${await signSession({ SESSION_SECRET: SECRET }, accountId)}`;
  else if (bogus) headers.cookie = "hd_session=bogus";
  return onRequestGet({
    request: new Request("http://x/api/provider-token", { headers }),
    env: { DB: db, SESSION_SECRET: SECRET, PROVIDER_TOKEN: token },
  });
}

describe("GET /api/provider-token", () => {
  it("401s without a session and with a bogus session", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call(null, PROVIDER_TOKEN, true)).status).toBe(401);
  });

  it("returns the distinct PROVIDER_TOKEN to a provider-role session", async () => {
    const res = await call(providerId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: PROVIDER_TOKEN });
  });

  it("403s a valid session that is not a provider", async () => {
    const res = await call(patientId);
    expect(res.status).toBe(403);
    expect((await res.json()).errorCode).toBe("not_a_provider");
  });

  it("500s when the provider token isn't configured", async () => {
    const res = await call(providerId, "");
    expect(res.status).toBe(500);
    expect((await res.json()).errorCode).toBe("unconfigured");
  });

  it("never leaks the token in a denied response", async () => {
    expect(await (await call(patientId)).text()).not.toContain(PROVIDER_TOKEN);
  });
});

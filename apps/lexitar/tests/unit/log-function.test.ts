import { describe, it, expect } from "vitest";
import { onRequestPost } from "../../functions/api/log";

function makeEnv() {
  const store = new Map<string, string>();
  return { store, PROVIDER_TOKEN: "provtok", STORE_PREFIX: "dev", VAULT: { put: async (k: string, v: string) => void store.set(k, v) } };
}

function call(env: ReturnType<typeof makeEnv>, opts: { auth?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  const body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? { event: "cancelled", attempt: 2 });
  return onRequestPost({ request: new Request("http://x/api/log", { method: "POST", headers, body }), env });
}

const written = (env: ReturnType<typeof makeEnv>) => JSON.parse([...env.store.values()][0]);

describe("POST /api/log — client loop-event beacon (W39 Phase 3)", () => {
  it("401s without / with a wrong PROVIDER_TOKEN and writes nothing", async () => {
    const env = makeEnv();
    expect((await call(env)).status).toBe(401);
    expect((await call(env, { auth: "Bearer nope" })).status).toBe(401);
    expect(env.store.size).toBe(0);
  });

  it("400s on malformed JSON and on an unknown/missing event", async () => {
    const env = makeEnv();
    expect((await call(env, { auth: "Bearer provtok", body: "{not json" })).status).toBe(400);
    expect((await call(env, { auth: "Bearer provtok", body: {} })).status).toBe(400);
    expect((await call(env, { auth: "Bearer provtok", body: { event: "accepted" } })).status).toBe(400); // server-only event
    expect(env.store.size).toBe(0);
  });

  it("204s and persists an allowlisted client event to R2", async () => {
    const env = makeEnv();
    const res = await call(env, { auth: "Bearer provtok", body: { event: "gave-up", attempt: 3, errorCode: "validation_exhausted" } });
    expect(res.status).toBe(204);
    expect(written(env)).toMatchObject({ route: "/api/refresh-finding", event: "gave-up", attempt: 3, errorCode: "validation_exhausted" });
  });

  it("PHI-free: drops a prose reasonCategory and never echoes unknown body fields", async () => {
    const env = makeEnv();
    await call(env, {
      auth: "Bearer provtok",
      body: {
        event: "validation-fail",
        attempt: 1,
        reasonCategory: "the patient's HbA1c of 8.2 suggests uncontrolled diabetes", // prose → must be dropped
        correction: "raw model prose about the patient", // unknown field → must never be echoed
        client: { displayName: "Alex" }, // PHI → must never be echoed
      },
    });
    const obj = written(env);
    expect(obj.reasonCategory).toBeUndefined(); // failed the slug regex → dropped
    expect(obj.correction).toBeUndefined();
    expect(obj.client).toBeUndefined();
    expect(obj).toMatchObject({ event: "validation-fail", attempt: 1 });
  });

  it("keeps a well-formed slug reasonCategory", async () => {
    const env = makeEnv();
    await call(env, { auth: "Bearer provtok", body: { event: "validation-fail", attempt: 1, reasonCategory: "validation" } });
    expect(written(env).reasonCategory).toBe("validation");
  });
});

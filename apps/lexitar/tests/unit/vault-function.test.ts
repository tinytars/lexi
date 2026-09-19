import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPut, onRequestGet } from "../../functions/api/vault/[id]";
import type { D1Database } from "../../functions/_lib/identity-types";
import { useWorkerd, emptyBucket } from "../support/miniflare";
import { hd1Blob as hd1 } from "../support/blobs";

const KEY = "dev/data-alex.enc"; // R2 key — store-prefixed (W13d)
const ASSET = "data-alex.enc"; // static-asset filename — unprefixed (Vite copies to dist root)

const w = useWorkerd({ r2: true });
afterEach(() => emptyBucket(w.bucket));

const stored = async (key: string) => {
  const obj = await w.bucket.get(key);
  return obj && new Uint8Array(await obj.arrayBuffer());
};
const bucketSize = async () => (await w.bucket.list()).objects.length;

const assetsFrom = (assets: Record<string, Uint8Array<ArrayBuffer>>) => async (req: Request) => {
  const key = new URL(req.url).pathname.replace(/^\//, "");
  return assets[key] ? new Response(assets[key]) : new Response(null, { status: 404 });
};

function makeEnv(fetchAsset: (req: Request) => Promise<Response> = assetsFrom({})) {
  return {
    VAULT_TOKEN: "t",
    STORE_PREFIX: "dev",
    // The ops bearer returns before the session gate, so the DB throws rather than answer (gate: vault-get-gate-function).
    SESSION_SECRET: "unused-by-the-bearer-path",
    DB: new Proxy({}, {
      get() { throw new Error("DB reached on the ops-bearer path — the VAULT_TOKEN guard should have returned first"); },
    }) as unknown as D1Database,
    VAULT: w.bucket,
    ASSETS: { fetch: fetchAsset },
  };
}

const putCtx = (env: ReturnType<typeof makeEnv>, opts: { auth?: string; body?: BodyInit } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  return {
    request: new Request("http://x/api/vault/alex", { method: "PUT", headers, body: opts.body ?? hd1() }),
    env,
    params: { id: "alex" },
  };
};
// GET is §G-gated; the ops bearer (VAULT_TOKEN) bypasses the session/envelope check, so these R2/
// self-seed behaviour tests use it. The session+envelope matrix lives in vault-get-gate-function.test.ts.
const getCtx = (env: ReturnType<typeof makeEnv>) => ({
  request: new Request("http://x/api/vault/alex", { headers: { authorization: "Bearer t" } }),
  env,
  params: { id: "alex" },
});

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("PUT /api/vault/:id", () => {
  it("401s without / with a wrong bearer and stores nothing", async () => {
    const env = makeEnv();
    expect((await onRequestPut(putCtx(env))).status).toBe(401);
    expect((await onRequestPut(putCtx(env, { auth: "Bearer nope" })).then((r) => r.status))).toBe(401);
    expect(await bucketSize()).toBe(0);
  });

  it("400s on a non-HD1 body", async () => {
    const env = makeEnv();
    const res = await onRequestPut(putCtx(env, { auth: "Bearer t", body: new Uint8Array(40) }));
    expect(res.status).toBe(400);
    expect(await bucketSize()).toBe(0);
  });

  it("400s on a too-short blob", async () => {
    const env = makeEnv();
    expect((await onRequestPut(putCtx(env, { auth: "Bearer t", body: hd1(10) }))).status).toBe(400);
  });

  it("413s on an oversized blob", async () => {
    const env = makeEnv();
    const res = await onRequestPut(putCtx(env, { auth: "Bearer t", body: hd1(5 * 1024 * 1024 + 1) }));
    expect(res.status).toBe(413);
    expect(await bucketSize()).toBe(0);
  });

  it("204s and stores a valid blob under data-{id}.enc", async () => {
    const env = makeEnv();
    const blob = hd1(64);
    const res = await onRequestPut(putCtx(env, { auth: "Bearer t", body: blob }));
    expect(res.status).toBe(204);
    expect(await stored(KEY)).toEqual(blob);
  });
});

describe("GET /api/vault/:id", () => {
  it("round-trips the stored blob", async () => {
    const env = makeEnv();
    const blob = hd1(64);
    await onRequestPut(putCtx(env, { auth: "Bearer t", body: blob }));
    const res = await onRequestGet(getCtx(env));
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(blob);
  });

  it("self-seeds R2 from the (unprefixed) static asset into the prefixed key on a miss", async () => {
    const asset = hd1(48);
    const env = makeEnv(assetsFrom({ [ASSET]: asset }));
    const res = await onRequestGet(getCtx(env));
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(asset);
    expect(await stored(KEY)).toEqual(asset); // seeded under dev/data-alex.enc for next time
  });

  it("404s when neither R2 nor a static asset has it", async () => {
    expect((await onRequestGet(getCtx(makeEnv()))).status).toBe(404);
  });

  it("404s (and does NOT seed) when ASSETS returns the SPA index.html, not a blob", async () => {
    // Prod Pages serves index.html (200) for unknown asset paths — must not be
    // mistaken for a vault blob (regression: unknown id returned 200 HTML + seeded R2).
    const env = makeEnv(async () => new Response("<!doctype html><html>app</html>"));
    const res = await onRequestGet({ request: new Request("http://x/api/vault/ghost", { headers: { authorization: "Bearer t" } }), env, params: { id: "ghost" } });
    expect(res.status).toBe(404);
    expect(await bucketSize()).toBe(0);
  });
});

describe("W8d vault-write audit logging is PHI-free", () => {
  let lines: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  afterEach(() => spy?.mockRestore());

  it("logs id + size on a write, never the blob bytes", async () => {
    lines = [];
    spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => { lines.push(String(l)); });
    const env = makeEnv();
    await onRequestPut(putCtx(env, { auth: "Bearer t", body: hd1(64) }));
    const entry = JSON.parse(lines.find((l) => l.includes('"/api/vault"'))!);
    expect(entry).toMatchObject({ route: "/api/vault", status: 204, id: "alex", bytes: 64 });
    expect(Object.keys(entry).sort()).toEqual(["at", "bytes", "id", "latencyMs", "route", "status"]);
  });
});

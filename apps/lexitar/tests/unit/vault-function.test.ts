import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPut, onRequestGet } from "../../functions/api/vault/[id]";
import type { D1Database } from "../../functions/_lib/identity-types";

const KEY = "dev/data-pablo.enc"; // R2 key — store-prefixed (W13d)
const ASSET = "data-pablo.enc"; // static-asset filename — unprefixed (Vite copies to dist root)

// HD1-prefixed blob of length n (>= 32 passes the validity check).
function hd1(n = 40): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  b[0] = 0x48; b[1] = 0x44; b[2] = 0x31;
  for (let i = 3; i < n; i++) b[i] = (i * 7) & 0xff;
  return b;
}

let etagSeq = 0;

function makeEnv(assets: Record<string, Uint8Array<ArrayBuffer>> = {}) {
  const store = new Map<string, Uint8Array<ArrayBuffer>>();
  const etags = new Map<string, string>();
  return {
    store,
    VAULT_TOKEN: "t",
    STORE_PREFIX: "dev",
    // W64 — Env requires these two. Every test here authenticates with the ops bearer, which
    // short-circuits before the session/envelope gate reads either (that matrix is covered against
    // a real Miniflare D1 in vault-get-gate-function.test.ts). They are present so the fake env is
    // the shape the Function actually receives; reaching them would be a bug in the guard order,
    // and the DB stub throws rather than pretending to answer.
    SESSION_SECRET: "unused-by-the-bearer-path",
    DB: new Proxy({}, {
      get() { throw new Error("DB reached on the ops-bearer path — the VAULT_TOKEN guard should have returned first"); },
    }) as unknown as D1Database,
    // W70 — the fake now models ETAGS and CONDITIONAL WRITES, because the Function depends on both.
    // A fake that always accepts a write cannot fail the way R2 does, so it would have reported the
    // concurrency guard working while it did nothing. The semantics mirrored here (null on a failed
    // precondition; a NEW etag on every successful write) are pinned against real workerd in
    // tests/unit/r2-conditional-put.test.ts, so the two cannot drift apart silently.
    VAULT: {
      get: async (k: string) => (store.has(k) ? { body: new Response(store.get(k)!).body!, etag: etags.get(k)! } : null),
      put: async (k: string, v: Uint8Array<ArrayBuffer>, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
        const current = etags.get(k);
        const cond = options?.onlyIf;
        if (cond?.etagMatches !== undefined && cond.etagMatches !== current) return null;
        if (cond?.etagDoesNotMatch === "*" && current !== undefined) return null;
        store.set(k, new Uint8Array(v));
        const next = `etag-${++etagSeq}`;
        etags.set(k, next);
        return { etag: next };
      },
      delete: async (k: string) => {
        store.delete(k);
        etags.delete(k);
      },
    },
    ASSETS: {
      fetch: async (req: Request) => {
        const key = new URL(req.url).pathname.replace(/^\//, "");
        return assets[key] ? new Response(assets[key]) : new Response(null, { status: 404 });
      },
    },
  };
}

const putCtx = (env: ReturnType<typeof makeEnv>, opts: { auth?: string; body?: BodyInit } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  return {
    request: new Request("http://x/api/vault/pablo", { method: "PUT", headers, body: opts.body ?? hd1() }),
    env,
    params: { id: "pablo" },
  };
};
// GET is §G-gated; the ops bearer (VAULT_TOKEN) bypasses the session/envelope check, so these R2/
// self-seed behaviour tests use it. The session+envelope matrix lives in vault-get-gate-function.test.ts.
const getCtx = (env: ReturnType<typeof makeEnv>) => ({
  request: new Request("http://x/api/vault/pablo", { headers: { authorization: "Bearer t" } }),
  env,
  params: { id: "pablo" },
});

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("PUT /api/vault/:id", () => {
  it("401s without / with a wrong bearer and stores nothing", async () => {
    const env = makeEnv();
    expect((await onRequestPut(putCtx(env))).status).toBe(401);
    expect((await onRequestPut(putCtx(env, { auth: "Bearer nope" })).then((r) => r.status))).toBe(401);
    expect(env.store.size).toBe(0);
  });

  it("400s on a non-HD1 body", async () => {
    const env = makeEnv();
    const res = await onRequestPut(putCtx(env, { auth: "Bearer t", body: new Uint8Array(40) }));
    expect(res.status).toBe(400);
    expect(env.store.size).toBe(0);
  });

  it("400s on a too-short blob", async () => {
    const env = makeEnv();
    expect((await onRequestPut(putCtx(env, { auth: "Bearer t", body: hd1(10) }))).status).toBe(400);
  });

  it("413s on an oversized blob", async () => {
    const env = makeEnv();
    const res = await onRequestPut(putCtx(env, { auth: "Bearer t", body: hd1(5 * 1024 * 1024 + 1) }));
    expect(res.status).toBe(413);
    expect(env.store.size).toBe(0);
  });

  it("204s and stores a valid blob under data-{id}.enc", async () => {
    const env = makeEnv();
    const blob = hd1(64);
    const res = await onRequestPut(putCtx(env, { auth: "Bearer t", body: blob }));
    expect(res.status).toBe(204);
    expect(env.store.get(KEY)).toEqual(blob);
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
    const env = makeEnv({ [ASSET]: asset });
    const res = await onRequestGet(getCtx(env));
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(asset);
    expect(env.store.get(KEY)).toEqual(asset); // seeded under dev/data-pablo.enc for next time
  });

  it("404s when neither R2 nor a static asset has it", async () => {
    expect((await onRequestGet(getCtx(makeEnv()))).status).toBe(404);
  });

  it("404s (and does NOT seed) when ASSETS returns the SPA index.html, not a blob", async () => {
    // Prod Pages serves index.html (200) for unknown asset paths — must not be
    // mistaken for a vault blob (regression: unknown id returned 200 HTML + seeded R2).
    const store = new Map<string, Uint8Array<ArrayBuffer>>();
    const env = {
      store,
      VAULT_TOKEN: "t",
      STORE_PREFIX: "dev",
      VAULT: {
        get: async (k: string) => (store.has(k) ? { body: new Response(store.get(k)!).body! } : null),
        put: async (k: string, v: Uint8Array<ArrayBuffer>) => { store.set(k, new Uint8Array(v)); },
      },
      ASSETS: { fetch: async () => new Response("<!doctype html><html>app</html>") },
    } as unknown as ReturnType<typeof makeEnv>;
    const res = await onRequestGet({ request: new Request("http://x/api/vault/ghost", { headers: { authorization: "Bearer t" } }), env, params: { id: "ghost" } });
    expect(res.status).toBe(404);
    expect(env.store.size).toBe(0);
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
    expect(entry).toMatchObject({ route: "/api/vault", status: 204, id: "pablo", bytes: 64 });
    expect(Object.keys(entry).sort()).toEqual(["at", "bytes", "id", "latencyMs", "route", "status"]);
  });
});

import { describe, it, expect } from "vitest";
import { onRequestGet } from "../../functions/api/logs";

// A tiny in-memory R2 stand-in matching the list/get surface logs.ts uses.
function makeEnv(seed: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  const VAULT = {
    list: async (opts: { prefix: string }) => ({
      objects: [...store.keys()].filter((k) => k.startsWith(opts.prefix)).map((key) => ({ key })),
      truncated: false as const,
    }),
    get: async (key: string) => (store.has(key) ? { text: async () => store.get(key)! } : null),
  };
  return { store, PROVIDER_TOKEN: "provtok", STORE_PREFIX: "dev", VAULT };
}

function call(env: unknown, opts: { auth?: string; query?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  const url = `http://x/api/logs${opts.query ?? "?route=refresh-finding"}`;
  return onRequestGet({ request: new Request(url, { method: "GET", headers }), env: env as never });
}

const K = (day: string, seq: number) => `dev/logs/refresh-finding/${day}/ray-${seq}.json`;

describe("GET /api/logs — provider-visible refresh audit read (W39 Phase 4)", () => {
  it("401s without / with a wrong PROVIDER_TOKEN", async () => {
    const env = makeEnv();
    expect((await call(env)).status).toBe(401);
    expect((await call(env, { auth: "Bearer nope" })).status).toBe(401);
  });

  it("400s on a non-slug route (no path traversal into other prefixes)", async () => {
    const env = makeEnv();
    const res = await call(env, { auth: "Bearer provtok", query: "?route=../vault" });
    expect(res.status).toBe(400);
  });

  it("returns entries newest-first by the persisted `at`, ignoring key order", async () => {
    const env = makeEnv({
      [K("2026-07-01", 0)]: { at: "2026-07-01T09:00:00.000Z", route: "/api/refresh-finding", status: 200, event: "accepted" },
      [K("2026-07-05", 1)]: { at: "2026-07-05T10:00:00.000Z", route: "/api/refresh-finding", status: 200, event: "stream-done", usage: { input: 4000, output: 9000 } },
      [K("2026-07-05", 0)]: { at: "2026-07-05T09:59:00.000Z", route: "/api/refresh-finding", status: 200, event: "accepted", attempt: 1 },
    });
    const res = await call(env, { auth: "Bearer provtok" });
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    expect(entries.map((e: { at: string }) => e.at)).toEqual([
      "2026-07-05T10:00:00.000Z",
      "2026-07-05T09:59:00.000Z",
      "2026-07-01T09:00:00.000Z",
    ]);
    expect(entries[0]).toMatchObject({ event: "stream-done", usage: { input: 4000, output: 9000 } });
  });

  it("only lists the requested route's prefix, not the whole bucket", async () => {
    const env = makeEnv({
      [K("2026-07-05", 0)]: { at: "2026-07-05T09:00:00.000Z", route: "/api/refresh-finding", status: 200, event: "success" },
      "dev/vault/alex.enc": { at: "x", secret: true }, // a non-log object must never surface
    });
    const { entries } = await (await call(env, { auth: "Bearer provtok" })).json();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("success");
  });

  it("skips a corrupt object instead of failing the whole read", async () => {
    const env = makeEnv();
    env.store.set(K("2026-07-05", 0), "{ not json");
    env.store.set(K("2026-07-05", 1), JSON.stringify({ at: "2026-07-05T09:00:00.000Z", route: "/api/refresh-finding", status: 200, event: "success" }));
    const { entries } = await (await call(env, { auth: "Bearer provtok" })).json();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("success");
  });

  it("degrades to an empty list when no R2 binding is present (console-only trail)", async () => {
    const env = { PROVIDER_TOKEN: "provtok", STORE_PREFIX: "dev" };
    const res = await call(env, { auth: "Bearer provtok" });
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toEqual([]);
  });
});

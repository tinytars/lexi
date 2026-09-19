import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, type Fetch } from "../../server/app";
import { assetServer, parseHeaders } from "../../server/assets";
import { FsBucket } from "../../server/fs-bucket";
import { applyPendingMigrations } from "../../server/migrations";
import { loadRoutes } from "../../server/routes";
import { SqliteD1Database } from "../../server/sqlite-d1";

// The Node host end to end below the socket: real functions/ routes, real SQLite with every migration,
// a real dist/ directory — the Pages behaviours the SPA depends on, not the routes' own logic.

const tmp = mkdtempSync(join(tmpdir(), "node-host-"));
const dist = join(tmp, "dist");
let db: SqliteD1Database;
let app: Fetch;

beforeAll(async () => {
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>spa</title>");
  writeFileSync(join(dist, "assets", "app.js"), "export {}");
  writeFileSync(join(dist, "assets", "404.html"), "missing asset");
  writeFileSync(join(dist, "data-x.enc"), "cipher");
  writeFileSync(join(tmp, "secret.txt"), "outside dist");
  writeFileSync(join(dist, "_headers"), "# comment\n/data*\n  Cache-Control: public, max-age=0, must-revalidate\n");
  db = new SqliteD1Database(":memory:");
  applyPendingMigrations(db);
  app = createApp({
    routes: await loadRoutes(fileURLToPath(new URL("../../functions/", import.meta.url))),
    env: { DB: db, VAULT: new FsBucket(join(tmp, "blobs")), SESSION_SECRET: "s", STORE_PREFIX: "t" },
    assets: assetServer(dist),
  });
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const get = (path: string, init?: RequestInit) => app(new Request(`http://localhost${path}`, init));

describe("Node host", () => {
  it("applies every migration once, seeds included, and records them", () => {
    const names = db.db.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map((r) => r.name);
    expect(names).toContain("0002_seed_migrated_accounts.sql");
    expect(applyPendingMigrations(db)).toEqual([]);
  });

  it("dispatches an /api path to its Function with env bound", async () => {
    const res = await get("/api/auth/password/salt?email=nobody@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ salt: expect.any(String), iterations: expect.any(Number) });
  });

  it("a Function's own error status passes through untouched", async () => {
    expect((await get("/api/auth/password/salt")).status).toBe(400);
    expect((await get("/api/account")).status).toBe(401);
  });

  it("serves assets with a content type, and _headers only where its pattern matches", async () => {
    const js = await get("/assets/app.js");
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(js.headers.get("cache-control")).toBeNull();
    const blob = await get("/data-x.enc");
    expect(await blob.text()).toBe("cipher");
    expect(blob.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it("answers unknown GET paths — an unclaimed /api path included — with the SPA", async () => {
    for (const path of ["/vault/deep/link", "/api/nope"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain("spa");
    }
  });

  it("answers a missing file under a directory with a 404.html with that page and a 404, not the SPA", async () => {
    const res = await get("/assets/index-OLDHASH.js");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("missing asset");
    expect(res.headers.get("content-type")).toMatch(/html/);
  });

  it("a method no Function handles falls through to assets, which only serve GET and HEAD", async () => {
    expect((await get("/api/auth/password/salt", { method: "DELETE" })).status).toBe(405);
    const head = await get("/assets/app.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("never serves a file outside dist/", async () => {
    for (const path of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      expect(await (await get(path)).text(), path).toContain("spa");
    }
  });
});

describe("parseHeaders", () => {
  it("reads splat and placeholder patterns with their indented headers", () => {
    const [a, b] = parseHeaders("/data*\n  X-A: 1\n  X-B: two: parts\n/u/:id/x\n  X-C: 3\n");
    expect(a.headers).toEqual([["X-A", "1"], ["X-B", "two: parts"]]);
    expect(a.pattern.test("/data-alex.enc")).toBe(true);
    expect(a.pattern.test("/x/data")).toBe(false);
    expect(b.pattern.test("/u/42/x")).toBe(true);
    expect(b.pattern.test("/u/4/2/x")).toBe(false);
  });
});

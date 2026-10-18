import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { loadRoutes, selectHandler, type LoadedRoute } from "../../server/routes";

// The Node host must route exactly as Pages does over the same functions/ tree. readdir lists
// `[link].ts` before `lookup.ts`, so the precedence cases fail unless the host actually ranks them.

const FUNCTIONS = fileURLToPath(new URL("../../functions/", import.meta.url));
let routes: LoadedRoute[];
beforeAll(async () => {
  routes = await loadRoutes(FUNCTIONS);
});

const resolve = (method: string, pathname: string) => {
  const hit = selectHandler(routes, method, pathname);
  if (!hit) return null;
  const route = routes.find((r) => Object.values(r.module).includes(hit.handler))!;
  return { file: route.file.slice(FUNCTIONS.length), params: hit.params };
};

describe("server/routes — Pages file-based routing over functions/", () => {
  it("loads every route file, each exporting a Pages handler, and no library file", () => {
    const files = routes.map((r) => r.file.slice(FUNCTIONS.length));
    expect(files).toContain("api/raw/[[path]].ts");
    expect(files.some((f) => f.startsWith("_lib/"))).toBe(false);
    for (const r of routes) expect(Object.keys(r.module).filter((k) => k.startsWith("onRequest")), r.file).not.toHaveLength(0);
  });

  it("maps static, index, param and catch-all paths, leaving params percent-encoded as Pages does", () => {
    expect(resolve("GET", "/api/account")).toEqual({ file: "api/account.ts", params: {} });
    expect(resolve("GET", "/api/providers")).toEqual({ file: "api/providers/index.ts", params: {} });
    expect(resolve("GET", "/api/providers/")).toEqual({ file: "api/providers/index.ts", params: {} });
    expect(resolve("GET", "/api/vault/abc")).toEqual({ file: "api/vault/[id].ts", params: { id: "abc" } });
    expect(resolve("GET", "/api/raw/c1/a%20b.pdf")).toEqual({ file: "api/raw/[[path]].ts", params: { path: ["c1", "a%20b.pdf"] } });
    expect(resolve("GET", "/api/raw")).toEqual({ file: "api/raw/[[path]].ts", params: { path: [] } });
  });

  it("a static segment outranks a param at the same depth", () => {
    expect(resolve("GET", "/api/providers/lookup")?.file).toBe("api/providers/lookup.ts");
    expect(resolve("GET", "/api/vault/org-key")?.file).toBe("api/vault/org-key.ts");
  });

  it("a route without the method falls through to the next match, then to nothing", () => {
    expect(resolve("DELETE", "/api/providers/lookup")?.file).toBe("api/providers/[link].ts");
    expect(resolve("GET", "/api/nope")).toBeNull();
    expect(resolve("GET", "/api/vault/a/b")).toBeNull();
    expect(resolve("DELETE", "/api/account/erase-typo")).toBeNull();
  });
});

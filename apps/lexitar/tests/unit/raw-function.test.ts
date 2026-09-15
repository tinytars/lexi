import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestGet, onRequestPut, onRequestDelete } from "../../functions/api/raw/[[path]]";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "./_session-db";

// W73 — the routes now resolve who owns a client namespace before touching R2. These tests are about
// content types, etags and path handling, so they seed "acct-1 owns the fixture namespaces" and leave
// the ownership MATRIX (owner vs provider vs stranger, live vs revoked) to raw-authorization.test.ts,
// which settles it against a real D1.
function ownedDb() {
  const db = fakeSessionDb();
  // Both store prefixes, because these fixtures do not agree on one ("dev" here, "test" there) and the
  // ownership key is store-scoped.
  for (const store of ["dev", "test"]) {
    for (const id of ["alex", "blair", "acct-1"]) {
      db.own(`${store}/raw/${id}/%`, "acct-1");
      db.own(`${store}/text/${id}/%`, "acct-1");
      db.own(`${store}/chat-${id}.enc`, "acct-1");
    }
  }
  return db;
}


const RAW = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-" — arbitrary bytes; never decrypted

function makeEnv(seed: Record<string, Uint8Array<ArrayBuffer>> = {}) {
  const store = new Map<string, Uint8Array<ArrayBuffer>>(Object.entries(seed));
  return {
    store,
    SESSION_SECRET: "test-secret",
    DB: ownedDb(),
    STORE_PREFIX: "dev",
    VAULT: {
      get: async (k: string) => (store.has(k) ? { body: new Response(store.get(k)!).body! } : null),
      put: async (k: string, v: Uint8Array<ArrayBuffer>) => { store.set(k, new Uint8Array(v)); },
      delete: async (k: string) => { store.delete(k); },
    },
  };
}

async function cookieHeader(auth?: "valid" | "bogus"): Promise<Record<string, string>> {
  if (auth === "valid") return { cookie: `hd_session=${await signSession({ SESSION_SECRET: "test-secret" }, "acct-1")}` };
  if (auth === "bogus") return { cookie: "hd_session=bogus" };
  return {};
}

const ctx = async (path: string[], auth?: "valid" | "bogus", method = "GET") => {
  const headers = await cookieHeader(auth);
  return {
    request: new Request("http://x/api/raw/" + path.join("/"), { method, headers }),
    env: makeEnv({ "dev/raw/alex/echo-597cd4e7.pdf": RAW }),
    params: { path },
  };
};

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("GET /api/raw/{id}/{file}", () => {
  it("401s without a bearer and with a wrong bearer", async () => {
    expect((await onRequestGet(await ctx(["alex", "echo-597cd4e7.pdf"]))).status).toBe(401);
    expect((await onRequestGet(await ctx(["alex", "echo-597cd4e7.pdf"], "bogus"))).status).toBe(401);
  });

  it("400s on a missing file segment or path traversal", async () => {
    expect((await onRequestGet(await ctx(["alex"], "valid"))).status).toBe(400);
    expect((await onRequestGet(await ctx(["alex", ".."], "valid"))).status).toBe(400);
  });

  it("404s when the object is absent", async () => {
    expect((await onRequestGet(await ctx(["alex", "ghost.pdf"], "valid"))).status).toBe(404);
  });

  it("200s and streams the bytes with a pdf content-type, from the store-prefixed key", async () => {
    const res = await onRequestGet(await ctx(["alex", "echo-597cd4e7.pdf"], "valid"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(await bytesOf(res)).toEqual(RAW);
  });

  it("lowercases the id so a capitalized vault key (e.g. 'Alex') resolves the lowercase raw key", async () => {
    const res = await onRequestGet(await ctx(["Alex", "echo-597cd4e7.pdf"], "valid"));
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(RAW);
  });

  // W46 — attachments generalize raw storage beyond pdf/xlsx/jpg/png.
  it.each([
    ["ab12cd34-photo.webp", "image/webp"],
    ["ab12cd34-photo.heic", "image/heic"],
    ["ab12cd34-photo.gif", "image/gif"],
  ])("serves %s with content-type %s", async (file, contentType) => {
    const context = await ctx(["alex", file], "valid");
    context.env = makeEnv({ [`dev/raw/alex/${file}`]: RAW });
    const res = await onRequestGet(context);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(contentType);
  });
});

describe("DELETE /api/raw/{id}/{file} (W13h web-delete shape)", () => {
  it("401s without a bearer", async () => {
    expect((await onRequestDelete(await ctx(["alex", "echo-597cd4e7.pdf"], undefined, "DELETE"))).status).toBe(401);
  });

  it("400s on a missing file segment or traversal", async () => {
    expect((await onRequestDelete(await ctx(["alex"], "valid", "DELETE"))).status).toBe(400);
    expect((await onRequestDelete(await ctx(["alex", ".."], "valid", "DELETE"))).status).toBe(400);
  });

  it("200s and removes the object so a subsequent GET 404s", async () => {
    // Share one env across DELETE then GET to observe the deletion.
    const env = makeEnv({ "dev/raw/alex/echo-597cd4e7.pdf": RAW });
    const c = async (method: string) => ({
      request: new Request("http://x/api/raw/alex/echo-597cd4e7.pdf", { method, headers: await cookieHeader("valid") }),
      env,
      params: { path: ["alex", "echo-597cd4e7.pdf"] },
    });
    const del = await onRequestDelete(await c("DELETE"));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect((await onRequestGet(await c("GET"))).status).toBe(404);
  });

  it("is idempotent — deleting an absent object still 200s", async () => {
    expect((await onRequestDelete(await ctx(["alex", "ghost.pdf"], "valid", "DELETE"))).status).toBe(200);
  });
});

describe("PUT /api/raw/{id}/{file} (W15/1 web upload)", () => {
  const putCtx = async (path: string[], opts: { auth?: "valid" | "bogus"; body?: BodyInit; env?: ReturnType<typeof makeEnv> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/pdf", ...(await cookieHeader(opts.auth)) };
    return {
      request: new Request("http://x/api/raw/" + path.join("/"), { method: "PUT", headers, body: opts.body ?? RAW }),
      env: opts.env ?? makeEnv(),
      params: { path },
    };
  };

  it("401s without / with a wrong bearer and stores nothing", async () => {
    const env = makeEnv();
    expect((await onRequestPut(await putCtx(["alex", "x.pdf"], { env }))).status).toBe(401);
    expect((await onRequestPut(await putCtx(["alex", "x.pdf"], { auth: "bogus", env }))).status).toBe(401);
    expect(env.store.size).toBe(0);
  });

  it("400s on a missing file segment or path traversal", async () => {
    expect((await onRequestPut(await putCtx(["alex"], { auth: "valid" }))).status).toBe(400);
    expect((await onRequestPut(await putCtx(["alex", ".."], { auth: "valid" }))).status).toBe(400);
  });

  it("400s on an empty body", async () => {
    expect((await onRequestPut(await putCtx(["alex", "x.pdf"], { auth: "valid", body: new Uint8Array(0) }))).status).toBe(400);
  });

  it("413s on an oversized body and stores nothing", async () => {
    const env = makeEnv();
    const res = await onRequestPut(await putCtx(["alex", "x.pdf"], { auth: "valid", body: new Uint8Array(24 * 1024 * 1024 + 1), env }));
    expect(res.status).toBe(413);
    expect(env.store.size).toBe(0);
  });

  it("204s, stores under the lowercased store-prefixed key, and round-trips via GET", async () => {
    const env = makeEnv();
    const put = await onRequestPut(await putCtx(["Alex", "2021October15-imaging-coronary-13da11c4.pdf"], { auth: "valid", body: RAW, env }));
    expect(put.status).toBe(204);
    expect(env.store.get("dev/raw/alex/2021October15-imaging-coronary-13da11c4.pdf")).toEqual(RAW);
    const get = await onRequestGet({
      request: new Request("http://x/api/raw/alex/2021October15-imaging-coronary-13da11c4.pdf", { headers: await cookieHeader("valid") }),
      env,
      params: { path: ["alex", "2021October15-imaging-coronary-13da11c4.pdf"] },
    });
    expect(get.status).toBe(200);
    expect(await bytesOf(get)).toEqual(RAW);
  });
});

describe("/api/raw logging is PHI-free", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  afterEach(() => spy?.mockRestore());

  it("logs route/status/id only — never the filename or bytes", async () => {
    const lines: string[] = [];
    spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => { lines.push(String(l)); });
    await onRequestGet(await ctx(["alex", "echo-597cd4e7.pdf"], "valid"));
    const entry = JSON.parse(lines.find((l) => l.includes('"/api/raw"'))!);
    // W75 — `access` joins the line deliberately: raw-owner.ts claimed the routes logged it so the
    // permissive-unclaimed decision was countable, and none did. It is an enum of four values, not
    // patient content, so the PHI-free property this test guards is unchanged.
    expect(entry).toMatchObject({ route: "/api/raw", status: 200, id: "alex", access: "owner" });
    expect(Object.keys(entry).sort()).toEqual(["access", "at", "id", "latencyMs", "route", "status"]);
  });
});

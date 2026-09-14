import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPut, onRequestGet } from "../../functions/api/chat-history/[id]";
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


const KEY = "dev/chat-alex.enc"; // R2 key — store-prefixed (W13d)

// HD1-prefixed blob of length n (>= 32 passes the validity check).
function hd1(n = 40): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  b[0] = 0x48; b[1] = 0x44; b[2] = 0x31;
  for (let i = 3; i < n; i++) b[i] = (i * 7) & 0xff;
  return b;
}

// W71 — the fake now carries etags and honours `onlyIf`, because the route now depends on both.
// Semantics copied from tests/unit/r2-conditional-put.test.ts, which pins them against real workerd:
// a failed precondition returns NULL rather than throwing.
function makeEnv() {
  const store = new Map<string, Uint8Array<ArrayBuffer>>();
  const tags = new Map<string, string>();
  let seq = 0;
  return {
    store,
    tags,
    SESSION_SECRET: "test-secret",
    DB: ownedDb(),
    STORE_PREFIX: "dev",
    VAULT: {
      get: async (k: string) => (store.has(k) ? { body: new Response(store.get(k)!).body!, etag: tags.get(k)! } : null),
      put: async (k: string, v: Uint8Array<ArrayBuffer>, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
        const cond = opts?.onlyIf;
        if (cond?.etagMatches !== undefined && tags.get(k) !== cond.etagMatches) return null;
        if (cond?.etagDoesNotMatch === "*" && store.has(k)) return null;
        store.set(k, new Uint8Array(v));
        const etag = `e${++seq}`;
        tags.set(k, etag);
        return { etag };
      },
    },
  };
}

const putCtx = async (env: ReturnType<typeof makeEnv>, opts: { auth?: "valid" | "bogus"; body?: BodyInit; ifMatch?: string; ifNoneMatch?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  if (opts.auth === "valid") headers.cookie = `hd_session=${await signSession(env, "acct-1")}`;
  else if (opts.auth === "bogus") headers.cookie = "hd_session=bogus";
  if (opts.ifMatch) headers["if-match"] = opts.ifMatch;
  if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;
  return {
    request: new Request("http://x/api/chat-history/alex", { method: "PUT", headers, body: opts.body ?? hd1() }),
    env,
    params: { id: "alex" },
  };
};
const getCtx = async (env: ReturnType<typeof makeEnv>, auth: "valid" | "bogus" | "none" = "valid") => ({
  request: new Request("http://x/api/chat-history/alex", {
    headers:
      auth === "valid" ? { cookie: `hd_session=${await signSession(env, "acct-1")}` } : auth === "bogus" ? { cookie: "hd_session=bogus" } : {},
  }),
  env,
  params: { id: "alex" },
});

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("PUT /api/chat-history/:id", () => {
  it("401s without / with a bogus session and stores nothing", async () => {
    const env = makeEnv();
    expect((await onRequestPut(await putCtx(env))).status).toBe(401);
    expect((await onRequestPut(await putCtx(env, { auth: "bogus" }))).status).toBe(401);
    expect(env.store.size).toBe(0);
  });

  it("400s on a non-HD1 or too-short blob", async () => {
    const env = makeEnv();
    expect((await onRequestPut(await putCtx(env, { auth: "valid", body: new Uint8Array(40) }))).status).toBe(400);
    expect((await onRequestPut(await putCtx(env, { auth: "valid", body: hd1(10) }))).status).toBe(400);
    expect(env.store.size).toBe(0);
  });

  it("413s on an oversized blob", async () => {
    const env = makeEnv();
    const res = await onRequestPut(await putCtx(env, { auth: "valid", body: hd1(2 * 1024 * 1024 + 1) }));
    expect(res.status).toBe(413);
    expect(env.store.size).toBe(0);
  });

  it("204s and stores a valid blob under the store-prefixed chat-{id}.enc key", async () => {
    const env = makeEnv();
    const blob = hd1(64);
    const res = await onRequestPut(await putCtx(env, { auth: "valid", body: blob }));
    expect(res.status).toBe(204);
    expect(env.store.get(KEY)).toEqual(blob);
  });
});

describe("GET /api/chat-history/:id", () => {
  it("round-trips the stored blob for a signed-in caller, and hands back its etag", async () => {
    const env = makeEnv();
    const blob = hd1(64);
    await onRequestPut(await putCtx(env, { auth: "valid", body: blob }));
    const res = await onRequestGet(await getCtx(env));
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(blob);
    // Without this the client has no If-Match token and every save is unconditional again.
    expect(res.headers.get("etag")).toBe(env.tags.get(KEY));
  });

  // W71 — this GET had NO auth at all. The blob is ciphertext, but it was an unauthenticated
  // PHI-ciphertext read keyed by a guessable slug: a standing offline-attack target that a patient
  // could neither see nor revoke, and the one route here with no gate whatsoever.
  it("401s without a session, and hands back nothing", async () => {
    const env = makeEnv();
    await onRequestPut(await putCtx(env, { auth: "valid", body: hd1(64) }));
    for (const auth of ["none", "bogus"] as const) {
      const res = await onRequestGet(await getCtx(env, auth));
      expect(res.status, auth).toBe(401);
      expect((await bytesOf(res)).length, auth).toBeLessThan(64);
    }
  });

  it("404s when the client has no saved history (first load → start fresh)", async () => {
    expect((await onRequestGet(await getCtx(makeEnv()))).status).toBe(404);
  });
});

// W71 — the same two-tab lost update /api/vault fixed in W70, one directory away. A whole-blob PUT
// with no precondition means the second tab to save silently discards everything the first wrote.
describe("PUT is conditional when the caller offers a precondition", () => {
  it("412s when the blob moved since it was read, and does not overwrite it", async () => {
    const env = makeEnv();
    await onRequestPut(await putCtx(env, { auth: "valid", body: hd1(64) }));
    const stale = env.tags.get(KEY)!;

    // A second tab saves first.
    const theirs = hd1(72);
    expect((await onRequestPut(await putCtx(env, { auth: "valid", body: theirs, ifMatch: stale }))).status).toBe(204);

    const res = await onRequestPut(await putCtx(env, { auth: "valid", body: hd1(80), ifMatch: stale }));
    expect(res.status).toBe(412);
    expect(env.store.get(KEY)).toEqual(theirs); // the winner's write is intact
    // The current etag rides along so the loser resolves in one round trip.
    expect(res.headers.get("etag")).toBe(env.tags.get(KEY));
  });

  it("If-None-Match: * refuses to clobber a blob this tab has never read", async () => {
    const env = makeEnv();
    const theirs = hd1(64);
    await onRequestPut(await putCtx(env, { auth: "valid", body: theirs }));
    const res = await onRequestPut(await putCtx(env, { auth: "valid", body: hd1(80), ifNoneMatch: "*" }));
    expect(res.status).toBe(412);
    expect(env.store.get(KEY)).toEqual(theirs);
  });

  // Deliberately NOT the vault's 428: a fresh conversation has no etag to send, so requiring a
  // precondition would refuse the first save every time.
  it("still accepts a first save with no precondition at all", async () => {
    const env = makeEnv();
    const res = await onRequestPut(await putCtx(env, { auth: "valid", body: hd1(64) }));
    expect(res.status).toBe(204);
    expect(res.headers.get("etag")).toBeTruthy();
  });
});

describe("W8d chat-history write audit is PHI-free", () => {
  let lines: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  afterEach(() => spy?.mockRestore());

  it("logs id + size on a write, never the blob bytes", async () => {
    lines = [];
    spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => { lines.push(String(l)); });
    const env = makeEnv();
    await onRequestPut(await putCtx(env, { auth: "valid", body: hd1(64) }));
    const entry = JSON.parse(lines.find((l) => l.includes('"/api/chat-history"'))!);
    expect(entry).toMatchObject({ route: "/api/chat-history", status: 204, id: "alex", bytes: 64, access: "owner" });
    expect(Object.keys(entry).sort()).toEqual(["access", "at", "bytes", "id", "latencyMs", "route", "status"]);
  });
});

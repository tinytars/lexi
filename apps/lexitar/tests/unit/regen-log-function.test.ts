import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPut, onRequestGet, isSegmentName } from "../../functions/api/regen-log/[id]";
import type { D1Database } from "../../functions/_lib/identity-types";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { fakeSessionDb } from "../support/session-db";
import { useWorkerd, emptyBucket, type Bucket } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";
import { hd1Blob as hd1 } from "../support/blobs";

// W87 — /api/regen-log/{id}, the append-only namespace the regen log moved into when one vault blob
// reached 5,163,393 bytes and /api/vault/{id} refused the next save.
//
// This route is deliberately unlike /api/chat-history, and the difference is what these tests pin:
// the client does not name the key, so there is no object two tabs can race for and no precondition,
// no etag round trip, no 412 and no unreadable-blob escape hatch. What replaces all of it is that
// the server mints the name and a segment is never rewritten — so the two properties worth more than
// the rest are that a second PUT ADDS an object rather than replacing one, and that a caller-supplied
// `?segment=` can only ever be a name this route itself could have minted.
//
// The ownership matrix is raw-authorization.test.ts's; here it is the one question of whether this
// namespace is asked at all, since it was added to raw-owner.ts's list and a route that forgot to
// consult it would read as working.

function ownedDb() {
  const db = fakeSessionDb();
  for (const store of ["dev", "test"]) {
    for (const id of ["alex", "blair"]) {
      db.own(`${store}/raw/${id}/%`, "acct-1");
      db.own(`${store}/text/${id}/%`, "acct-1");
      db.own(`${store}/regen-log/${id}/%`, "acct-1");
      db.own(`${store}/chat-${id}.enc`, "acct-1");
    }
  }
  return db;
}

const PREFIX = "dev/regen-log/alex/"; // R2 key — store-prefixed (W13d)

const w = useWorkerd({ r2: true });
afterEach(() => emptyBucket(w.bucket));

interface Env {
  SESSION_SECRET: string;
  DB: D1Database;
  STORE_PREFIX: string;
  VAULT: Bucket;
}
const makeEnv = (): Env => ({ SESSION_SECRET, DB: ownedDb(), STORE_PREFIX: "dev", VAULT: w.bucket });

const keys = async (prefix = PREFIX) => (await w.bucket.list({ prefix })).objects.map((o) => o.key).sort();
const bucketSize = async () => (await w.bucket.list()).objects.length;
const stored = async (key: string) => {
  const obj = await w.bucket.get(key);
  return obj && new Uint8Array(await obj.arrayBuffer());
};

type Auth = "owner" | "stranger" | "bogus" | "none";
const authHeader = async (auth: Auth): Promise<Record<string, string>> =>
  auth === "owner"
    ? { cookie: await cookieFor("acct-1") }
    : auth === "stranger"
      ? { cookie: await cookieFor("acct-2") }
      : auth === "bogus"
        ? { cookie: "hd_session=bogus" }
        : {};

const putCtx = async (env: Env, opts: { auth?: Auth; body?: BodyInit; id?: string } = {}) => ({
  request: new Request(`http://x/api/regen-log/${opts.id ?? "alex"}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", ...(await authHeader(opts.auth ?? "none")) },
    body: opts.body ?? hd1(),
  }),
  env,
  params: { id: opts.id ?? "alex" },
});

const getCtx = async (env: Env, opts: { auth?: Auth; segment?: string; id?: string } = {}) => {
  const url = new URL(`http://x/api/regen-log/${opts.id ?? "alex"}`);
  if (opts.segment !== undefined) url.searchParams.set("segment", opts.segment);
  return {
    request: new Request(url, { headers: await authHeader(opts.auth ?? "owner") }),
    env,
    params: { id: opts.id ?? "alex" },
  };
};

/** PUT a valid segment as the owner and hand back the name the server minted. */
async function append(env: Env, body?: Uint8Array<ArrayBuffer>): Promise<string> {
  const res = await onRequestPut(await putCtx(env, { auth: "owner", body: body ?? hd1(64) }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { segment: string }).segment;
}

describe("PUT /api/regen-log/:id", () => {
  it("401s without / with a bogus session and stores nothing", async () => {
    const env = makeEnv();
    expect((await onRequestPut(await putCtx(env))).status).toBe(401);
    expect((await onRequestPut(await putCtx(env, { auth: "bogus" }))).status).toBe(401);
    expect(await bucketSize()).toBe(0);
  });

  // The namespace is shared with raw/, text/ and chat-, so an account that owns none of it must not
  // be able to append evidence into another patient's record either.
  it("404s for a signed-in stranger and stores nothing", async () => {
    const env = makeEnv();
    const res = await onRequestPut(await putCtx(env, { auth: "stranger" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(await bucketSize()).toBe(0);
  });

  it("400s on a non-HD1 or too-short blob", async () => {
    const env = makeEnv();
    expect((await onRequestPut(await putCtx(env, { auth: "owner", body: new Uint8Array(40) }))).status).toBe(400);
    expect((await onRequestPut(await putCtx(env, { auth: "owner", body: hd1(10) }))).status).toBe(400);
    expect(await bucketSize()).toBe(0);
  });

  // The numbers are in the body because the vault's own 413 arrived without them and cost a full
  // investigation to learn what the blob actually weighed. Both are sizes, never content.
  it("413s on an oversized segment, saying how big and how big is allowed", async () => {
    const env = makeEnv();
    const res = await onRequestPut(await putCtx(env, { auth: "owner", body: hd1(8 * 1024 * 1024 + 1) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "regen log segment too large",
      bytes: 8 * 1024 * 1024 + 1,
      max: 8 * 1024 * 1024,
    });
    expect(await bucketSize()).toBe(0);
  });

  it("201s, stores the blob under a minted key, and hands the name back", async () => {
    const env = makeEnv();
    const blob = hd1(64);
    const segment = await append(env, blob);

    expect(isSegmentName(segment)).toBe(true);
    expect(await keys()).toEqual([`${PREFIX}${segment}`]);
    expect(await stored(`${PREFIX}${segment}`)).toEqual(blob);
  });

  // The append-only property, and the whole reason this is not one blob: the second write must cost
  // nothing in the size of the log, and must not be able to destroy the first.
  it("adds an object per append and never rewrites one", async () => {
    const env = makeEnv();
    const first = hd1(64);
    const second = hd1(72);
    const a = await append(env, first);
    const b = await append(env, second);

    expect(a).not.toBe(b);
    expect(await keys()).toEqual([`${PREFIX}${a}`, `${PREFIX}${b}`].sort());
    expect(await stored(`${PREFIX}${a}`)).toEqual(first);
    expect(await stored(`${PREFIX}${b}`)).toEqual(second);
  });

  it("writes under the caller's own client namespace and nowhere else", async () => {
    const env = makeEnv();
    await append(env);
    expect(await keys("dev/")).toHaveLength(1);
    expect((await keys("dev/"))[0].startsWith(PREFIX)).toBe(true);
  });
});

describe("GET /api/regen-log/:id", () => {
  it("lists the segment names, time-sorted and relative to the namespace", async () => {
    const env = makeEnv();
    const a = await append(env);
    const b = await append(env);

    const res = await onRequestGet(await getCtx(env));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ segments: [a, b].sort() });
  });

  it("reads back one segment's ciphertext byte for byte, uncached", async () => {
    const env = makeEnv();
    const blob = hd1(96);
    const segment = await append(env, blob);

    const res = await onRequestGet(await getCtx(env, { segment }));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(blob);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    // PHI ciphertext has no business in any shared cache between here and the browser.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBe((await w.bucket.get(`${PREFIX}${segment}`))!.etag);
  });

  // `?segment=` is the one place a caller-supplied string reaches an R2 key. It is matched against
  // the minted shape rather than screened for `..` and `/`, because a denylist admits whatever
  // nobody thought of — so these have to fail on the shape, before any bucket read.
  it("400s on anything it could not have minted itself", async () => {
    const env = makeEnv();
    const stranger = hd1(64);
    await w.bucket.put("dev/data-alex.enc", stranger as unknown as ArrayBufferView);

    for (const segment of [
      "../data-alex.enc",
      "../../dev/data-alex.enc",
      "2026-01-01T00-00-00-000Z-0a1b2c3d.enc/../../data-alex.enc",
      "2026-01-01T00-00-00-000Z-nothex0.enc",
      "whatever.enc",
      "",
    ]) {
      const res = await onRequestGet(await getCtx(env, { segment }));
      expect(res.status, segment).toBe(400);
      expect(await res.json()).toEqual({ error: "not a segment name" });
    }
    // Nothing outside the namespace was read, and the object is still exactly as it was.
    expect(await stored("dev/data-alex.enc")).toEqual(stranger);
  });

  it("404s on a well-formed name that was never written", async () => {
    const env = makeEnv();
    await append(env);
    const res = await onRequestGet(await getCtx(env, { segment: "2026-01-01T00-00-00-000Z-0a1b2c3d.enc" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "segment not found" });
  });

  // An empty list and not a 404: a record whose log has never been written is the ordinary state of
  // every client, and the reader has to be able to tell it from a failure.
  it("answers an empty list for an owned namespace with no segments yet", async () => {
    expect(await onRequestGet(await getCtx(makeEnv())).then((r) => r.json())).toEqual({ segments: [] });
  });

  it("401s without a session and 404s for a stranger, handing back no ciphertext", async () => {
    const env = makeEnv();
    const segment = await append(env, hd1(64));
    for (const auth of ["none", "bogus"] as const) {
      expect((await onRequestGet(await getCtx(env, { auth, segment }))).status, auth).toBe(401);
    }
    const res = await onRequestGet(await getCtx(env, { auth: "stranger", segment }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

// A first write into an EMPTY namespace is allowed and claims it — the same rule raw/ runs on, and
// the reason it has to hold here is that a patient whose first regen predates any attachment has
// claimed nothing yet. Against the real D1, because the claim is an insert and a fake would answer
// whatever it was told rather than what the route actually wrote.
describe("the first append claims the namespace", () => {
  const realEnv = (): Env => ({ SESSION_SECRET, DB: w.db, STORE_PREFIX: "dev", VAULT: w.bucket });

  it("admits the first writer and then refuses everybody else", async () => {
    const env = realEnv();
    const id = "unclaimed-client";
    // Both accounts have to exist for real here: requireSession reads the account row to honour a
    // revocation, so a session for an account D1 has never heard of is refused before any ownership
    // question is asked. The fake above answers that lookup for any id; this one does not.
    for (const accountId of ["acct-1", "acct-2"]) {
      await createAccount(w.db, { id: accountId, displayName: accountId, email: `${accountId}@example.test` });
    }
    const first = await onRequestPut(await putCtx(env, { auth: "owner", body: hd1(64), id }));
    expect(first.status).toBe(201);

    // The claim is now on the record, so the same account reads it and another account cannot —
    // neither to read it nor to append to it.
    expect((await onRequestGet(await getCtx(env, { auth: "owner", id }))).status).toBe(200);
    expect((await onRequestGet(await getCtx(env, { auth: "stranger", id }))).status).toBe(404);
    expect((await onRequestPut(await putCtx(env, { auth: "stranger", body: hd1(64), id }))).status).toBe(404);
    expect(await keys(`dev/regen-log/${id}/`)).toHaveLength(1);
  });
});

describe("the write audit is PHI-free", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  afterEach(() => spy?.mockRestore());

  it("logs the client id, the size and the access kind, never the bytes", async () => {
    const lines: string[] = [];
    spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => { lines.push(String(l)); });
    await append(makeEnv(), hd1(64));

    const entry = JSON.parse(lines.find((l) => l.includes('"/api/regen-log"'))!);
    expect(entry).toMatchObject({ route: "/api/regen-log", status: 201, id: "alex", bytes: 64, access: "owner" });
    // The minted segment name is deliberately NOT logged: it is derived from the clock, and a key is
    // the one field that would let a log line be lined up against a patient's stored object.
    expect(Object.keys(entry).sort()).toEqual(["access", "at", "bytes", "id", "latencyMs", "route", "status"]);
  });
});

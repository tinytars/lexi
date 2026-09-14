import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";

// W70 Phase 0 — pin R2's conditional-write semantics against real workerd, before any product code
// depends on them.
//
// The whole "two tabs silently clobber each other" fix (functions/api/vault/[id].ts:86, a bare
// env.VAULT.put with no ETag or If-Match) rests on optimistic concurrency: GET hands the browser an
// etag, PUT sends it back, and the write is refused if the object moved underneath. Cloudflare's
// reference says put(k, v, { onlyIf: { etagMatches } }) returns NULL on precondition failure rather
// than throwing — but that could not be verified from this repo: @cloudflare/workers-types is not
// installed at all, and functions/api/vault/[id].ts:10-18 deliberately hand-rolls its own R2Bucket /
// R2ObjectBody interfaces precisely so the Function needs no such dependency.
//
// Documentation is not a runtime. This runs the real thing and pins what it actually does, so the
// design either stands on an observed fact or is stopped here. If conditional put turns out not to be
// a precondition, Phase 1a is dead and the fallback (a version counter inside the encrypted blob plus
// read-before-write, which leaves a TOCTOU window) is strictly worse and warrants a re-plan.

let mf: Miniflare;
let bucket: any;

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    r2Buckets: { VAULT: "test-vault-conditional" },
  });
  bucket = await mf.getR2Bucket("VAULT");
});
afterAll(async () => {
  await mf.dispose();
});

/** Read an object's body back as text, so "did the bytes change" is answered by the bytes. */
async function bodyOf(key: string): Promise<string> {
  const obj = await bucket.get(key);
  return obj ? await obj.text() : "";
}

describe("R2 conditional writes — the primitive Phase 1 depends on", () => {
  it("put() returns an object carrying an etag, and get() reports the same one", async () => {
    const put = await bucket.put("k-etag", bytes("v1"));
    expect(put).toBeTruthy();
    expect(typeof put.etag).toBe("string");
    expect(put.etag.length).toBeGreaterThan(0);

    const got = await bucket.get("k-etag");
    expect(got.etag).toBe(put.etag);
    // httpEtag is the quoted form, suitable for an ETag response header.
    expect(got.httpEtag).toContain(put.etag);
  });

  // The load-bearing assertion. If this does not refuse the write, the design is wrong.
  it("a STALE etagMatches refuses the write and leaves the bytes untouched", async () => {
    const first = await bucket.put("k-stale", bytes("original"));
    await bucket.put("k-stale", bytes("someone else's write")); // the other tab wins

    let threw: unknown = null;
    let result: unknown = "not-set";
    try {
      result = await bucket.put("k-stale", bytes("my stale write"), { onlyIf: { etagMatches: first.etag } });
    } catch (e) {
      threw = e;
    }

    // Pin the EXACT signal. Phase 1a reads this to decide how the Function detects a conflict, and
    // guessing wrong means a silent overwrite in production — the precise bug being fixed. Accepting
    // "null or a throw" would leave that guess open, so assert the observed one and say so out loud.
    // eslint-disable-next-line no-console
    console.log(`[W70 Phase 0] stale etagMatches -> ${threw ? `THREW ${(threw as Error).name}` : `returned ${JSON.stringify(result)}`}`);
    expect(threw, "conditional put should signal by return value, not by throwing").toBeNull();
    expect(result, "a failed precondition must return null").toBeNull();

    // Whatever the signal, the write must NOT have landed.
    expect(await bodyOf("k-stale")).toBe("someone else's write");
  });

  it("a CURRENT etagMatches succeeds and yields a new etag", async () => {
    const first = await bucket.put("k-current", bytes("v1"));
    const second = await bucket.put("k-current", bytes("v2"), { onlyIf: { etagMatches: first.etag } });

    expect(second).toBeTruthy();
    expect(second.etag).not.toBe(first.etag);
    expect(await bodyOf("k-current")).toBe("v2");
  });

  // The create case: the browser has no etag for a vault that does not exist yet. This is the
  // condition that expresses "only if absent", and the self-seed path in the Function needs it.
  it("etagDoesNotMatch '*' expresses create-if-absent", async () => {
    const created = await bucket.put("k-create", bytes("first"), { onlyIf: { etagDoesNotMatch: "*" } });
    expect(created).toBeTruthy();

    let second: unknown = "not-set";
    try {
      second = await bucket.put("k-create", bytes("second"), { onlyIf: { etagDoesNotMatch: "*" } });
    } catch {
      second = null;
    }
    expect(second).toBeNull();
    expect(await bodyOf("k-create")).toBe("first");
  });

  // Decides whether the Function forwards the client's If-Match header verbatim or parses it out.
  it("records whether onlyIf accepts a Headers object", async () => {
    const first = await bucket.put("k-headers", bytes("v1"));
    let accepted = true;
    try {
      const r = await bucket.put("k-headers", bytes("v2"), {
        onlyIf: new Headers({ "If-Match": first.httpEtag }),
      });
      accepted = r !== null;
    } catch {
      accepted = false;
    }
    // Not an assertion about which is correct — a record of what this runtime does, so Phase 1a
    // picks the simpler of the two paths knowingly.
    expect(typeof accepted).toBe("boolean");
    // eslint-disable-next-line no-console
    console.log(`[W70 Phase 0] onlyIf accepts a Headers object: ${accepted}`);
  });
});

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectBucket } from "../../functions/_lib/object-bucket";
import { FsBucket } from "../../server/fs-bucket";
import { useWorkerd } from "../support/miniflare";

// One contract, two backends: real workerd R2 (what production binds) and FsBucket (the Node host).
// A case that passes on R2 and fails on FsBucket is a Node-host bug, never a reason to loosen the case.

function runObjectBucketConformance(label: string, bucket: () => ObjectBucket) {
  describe(`ObjectBucket conformance (${label})`, () => {
    it("get returns null for a missing key", async () => {
      expect(await bucket().get("missing")).toBeNull();
    });

    it("round-trips bytes and strings, and get's etag is the one put returned", async () => {
      const b = bucket();
      const put = await b.put("bytes", new Uint8Array([1, 2, 3]));
      const got = await b.get("bytes");
      expect(got?.etag).toBe(put?.etag);
      expect([...new Uint8Array(await got!.arrayBuffer())]).toEqual([1, 2, 3]);

      await b.put("text", "héllo");
      expect(await (await b.get("text"))!.text()).toBe("héllo");
      expect(await new Response((await b.get("text"))!.body).text()).toBe("héllo");
    });

    it("etagMatches writes on a match and returns null, leaving the object, on a mismatch", async () => {
      const b = bucket();
      const first = await b.put("m", "v1");
      const second = await b.put("m", "v2", { onlyIf: { etagMatches: first!.etag } });
      expect(second?.etag).toBeTruthy();
      expect(second?.etag).not.toBe(first?.etag);

      expect(await b.put("m", "v3", { onlyIf: { etagMatches: first!.etag } })).toBeNull();
      expect(await (await b.get("m"))!.text()).toBe("v2");
    });

    it("etagMatches against a missing key fails", async () => {
      const b = bucket();
      expect(await b.put("absent", "x", { onlyIf: { etagMatches: "anything" } })).toBeNull();
      expect(await b.get("absent")).toBeNull();
    });

    it("etagDoesNotMatch '*' creates only when nothing is there", async () => {
      const b = bucket();
      expect(await b.put("once", "a", { onlyIf: { etagDoesNotMatch: "*" } })).not.toBeNull();
      expect(await b.put("once", "b", { onlyIf: { etagDoesNotMatch: "*" } })).toBeNull();
      expect(await (await b.get("once"))!.text()).toBe("a");
    });

    it("delete removes the object and is a no-op for a missing key", async () => {
      const b = bucket();
      await b.put("gone", "x");
      await b.delete("gone");
      expect(await b.get("gone")).toBeNull();
      await expect(b.delete("never-was")).resolves.toBeUndefined();
    });

    it("list filters by prefix, ascends by key, and keeps slashes and non-ASCII keys intact", async () => {
      const b = bucket();
      for (const k of ["p/b", "p/a b/ü.pdf", "p/a", "q/a"]) await b.put(k, k);
      const { objects, truncated } = await b.list({ prefix: "p/" });
      expect(objects.map((o) => o.key)).toEqual(["p/a", "p/a b/ü.pdf", "p/b"]);
      expect(truncated).toBe(false);
    });

    it("list pages with limit + cursor until truncated is false, visiting every key once", async () => {
      const b = bucket();
      const all = ["pg/1", "pg/2", "pg/3", "pg/4", "pg/5"];
      for (const k of all) await b.put(k, k);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await b.list(cursor ? { prefix: "pg/", limit: 2, cursor } : { prefix: "pg/", limit: 2 });
        seen.push(...page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
        pages++;
      } while (cursor);
      expect(seen).toEqual(all);
      expect(pages).toBe(3);
    });
  });
}

const w = useWorkerd({ r2: true, workerdOnly: true });
runObjectBucketConformance("workerd R2", () => w.bucket as unknown as ObjectBucket);

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
runObjectBucketConformance("FsBucket", () => {
  const d = mkdtempSync(join(tmpdir(), "fs-bucket-"));
  dirs.push(d);
  return new FsBucket(d);
});

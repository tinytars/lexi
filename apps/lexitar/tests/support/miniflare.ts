import { beforeAll, afterAll, beforeEach } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../functions/_lib/identity-types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "./migrate";
import { SqliteD1Database } from "../../server/sqlite-d1";
import { FsBucket } from "../../server/fs-bucket";

// Miniflare's own R2Bucket return type needs @cloudflare/workers-types (not installed) and otherwise
// degrades to Request; this is the subset the tests use.
export interface Bucket {
  put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: { onlyIf?: object }): Promise<{ etag: string; httpEtag: string } | null>;
  get(key: string): Promise<{ body: ReadableStream; etag: string; httpEtag: string; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

// Miniflare 5 takes a wrangler-shaped config per worker instead of v4's top-level `script`/`d1Databases`
// shorthand: the stub worker is a module in `config.manifest` and the bindings live in `config.env`.
// Nothing fetches this worker — it exists because an instance needs a script to hang the bindings off.
const MAIN_MODULE = "index.mjs";
const SCRIPT = "export default { fetch() { return new Response('ok'); } }";
// Matches wrangler.jsonc, so the local D1/R2 run the same workerd semantics production does.
const COMPATIBILITY_DATE = "2026-05-26";

// A streaming route's writes can still be landing in the bucket directory when the test file that
// started it ends, and a removal that meets one dies with ENOTEMPTY: `force` forgives a directory
// that is already gone, not one that refills between the readdir and the rmdir. The wait has to
// yield to the event loop and not merely sleep in it — node's own retryDelay blocks the writes it
// is waiting out, which is why a 2-core runner still lost the race with retries alone.
export async function removeTestDir(dir: string, deadlineMs = 15_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY" || Date.now() >= until) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export interface Workerd {
  readonly db: D1Database;
  readonly bucket: Bucket;
}

// TEST_BACKEND=node runs the same suite against the Node host's adapters instead of workerd — the proof
// that every route behaves identically off Cloudflare. `workerdOnly` pins files that test R2/D1 itself.
const NODE_BACKEND = process.env.TEST_BACKEND === "node";

// The test-side Bucket surface (delete of many, list without a prefix) over the Node host's FsBucket.
function fsTestBucket(root: string): Bucket {
  const fs = new FsBucket(root);
  return {
    get: (key) => fs.get(key) as ReturnType<Bucket["get"]>,
    put: async (key, value, options) => {
      const bytes = typeof value === "string" ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const put = await fs.put(key, bytes, options as Parameters<FsBucket["put"]>[2]);
      return put && { etag: put.etag, httpEtag: `"${put.etag}"` };
    },
    delete: async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) await fs.delete(k);
    },
    list: (opts) => fs.list({ prefix: opts?.prefix ?? "", ...(opts?.cursor ? { cursor: opts.cursor } : {}) }),
  };
}

// A real workerd D1 (migrated) and R2 for the calling test file; created once, disposed after.
// `perTest` rebuilds both before every test, for files whose fixtures collide on fixed names.
// Read `db`/`bucket` inside tests or hooks — they exist only after the setup hook has run.
export function useWorkerd(opts: { r2?: boolean; perTest?: boolean; workerdOnly?: boolean } = {}): Workerd {
  let mf: Miniflare | undefined;
  let sqlite: SqliteD1Database | undefined;
  let dir: string | undefined;
  let db: D1Database | undefined;
  let bucket: Bucket | undefined;
  const dispose = async () => {
    await mf?.dispose();
    sqlite?.close();
    if (dir) await removeTestDir(dir);
    mf = sqlite = dir = undefined;
  };
  (opts.perTest ? beforeEach : beforeAll)(async () => {
    await dispose();
    if (NODE_BACKEND && !opts.workerdOnly) {
      db = sqlite = new SqliteD1Database(":memory:");
      await applyMigrations(db);
      if (opts.r2) bucket = fsTestBucket((dir = mkdtempSync(join(tmpdir(), "lexi-r2-"))));
      return;
    }
    mf = new Miniflare({
      workers: [
        {
          config: {
            name: "lexi-test",
            compatibilityDate: COMPATIBILITY_DATE,
            manifest: { mainModule: MAIN_MODULE, modules: { [MAIN_MODULE]: { type: "esm", contents: SCRIPT } } },
            env: {
              DB: { type: "d1", id: crypto.randomUUID() },
              ...(opts.r2 ? { VAULT: { type: "r2" as const, name: crypto.randomUUID() } } : {}),
            },
          },
        },
      ],
    });
    db = (await mf.getD1Database("DB")) as unknown as D1Database;
    await applyMigrations(db);
    if (opts.r2) bucket = (await mf.getR2Bucket("VAULT")) as unknown as Bucket;
  });
  afterAll(dispose);
  return {
    get db() {
      if (!db) throw new Error("useWorkerd: db read before beforeAll ran");
      return db;
    },
    get bucket() {
      if (!bucket) throw new Error("useWorkerd: bucket read without { r2: true } or before beforeAll ran");
      return bucket;
    },
  };
}

// For files that share one bucket across tests but assert on its whole contents.
export async function emptyBucket(bucket: Bucket): Promise<void> {
  const { objects } = await bucket.list();
  if (objects.length) await bucket.delete(objects.map((o) => o.key));
}

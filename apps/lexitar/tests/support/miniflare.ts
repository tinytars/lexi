import { beforeAll, afterAll, beforeEach } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../functions/_lib/identity-types";
import { applyMigrations } from "./migrate";

// Miniflare's own R2Bucket return type needs @cloudflare/workers-types (not installed) and otherwise
// degrades to Request; this is the subset the tests use.
export interface Bucket {
  put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: { onlyIf?: object }): Promise<{ etag: string; httpEtag: string } | null>;
  get(key: string): Promise<{ body: ReadableStream; etag: string; httpEtag: string; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

const SCRIPT = "export default { fetch() { return new Response('ok'); } }";

export interface Workerd {
  readonly db: D1Database;
  readonly bucket: Bucket;
}

// A real workerd D1 (migrated) and R2 for the calling test file; created once, disposed after.
// `perTest` rebuilds both before every test, for files whose fixtures collide on fixed names.
// Read `db`/`bucket` inside tests or hooks — they exist only after the setup hook has run.
export function useWorkerd(opts: { r2?: boolean; perTest?: boolean } = {}): Workerd {
  let mf: Miniflare | undefined;
  let db: D1Database | undefined;
  let bucket: Bucket | undefined;
  (opts.perTest ? beforeEach : beforeAll)(async () => {
    await mf?.dispose();
    mf = new Miniflare({
      modules: true,
      script: SCRIPT,
      d1Databases: { DB: crypto.randomUUID() },
      ...(opts.r2 ? { r2Buckets: { VAULT: crypto.randomUUID() } } : {}),
    });
    db = (await mf.getD1Database("DB")) as unknown as D1Database;
    await applyMigrations(db);
    if (opts.r2) bucket = (await mf.getR2Bucket("VAULT")) as unknown as Bucket;
  });
  afterAll(async () => {
    await mf?.dispose();
  });
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

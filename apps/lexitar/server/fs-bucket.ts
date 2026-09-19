import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectBucket, ObjectConditional, ObjectListing, StoredObject } from "../functions/_lib/object-bucket";

// ObjectBucket on a local directory, for the Node host. One flat file per key (the key URI-encoded,
// so a key can never name a path outside `root`); the etag is the content hash, as R2's is. Where R2
// semantics are subtle — conditional writes, list order and paging — tests/unit/
// object-bucket-conformance.test.ts runs the same suite against this and real workerd R2.

const SUFFIX = ".obj";
const DEFAULT_LIST_LIMIT = 1000;

const etagOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function preconditionFails(current: string | null, onlyIf?: ObjectConditional): boolean {
  if (!onlyIf) return false;
  if (onlyIf.etagMatches !== undefined && onlyIf.etagMatches !== current) return true;
  if (onlyIf.etagDoesNotMatch === "*") return current !== null;
  return onlyIf.etagDoesNotMatch !== undefined && onlyIf.etagDoesNotMatch === current;
}

export function storedObject(bytes: Uint8Array): StoredObject {
  const response = () => new Response(bytes as Uint8Array<ArrayBuffer>);
  return { body: response().body!, etag: etagOf(bytes), arrayBuffer: () => response().arrayBuffer(), text: () => response().text() };
}

export class FsBucket implements ObjectBucket {
  // Serialises the read-check-write of a conditional put per key within this process.
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  private file(key: string): string {
    return join(this.root, encodeURIComponent(key) + SUFFIX);
  }

  private async read(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.file(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => {});
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  async get(key: string): Promise<StoredObject | null> {
    const bytes = await this.read(key);
    return bytes && storedObject(bytes);
  }

  put(key: string, value: string | Uint8Array, options?: { onlyIf?: ObjectConditional }): Promise<{ etag: string } | null> {
    return this.withLock(key, async () => {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      if (options?.onlyIf) {
        const current = await this.read(key);
        if (preconditionFails(current && etagOf(current), options.onlyIf)) return null;
      }
      const tmp = join(this.root, `.tmp-${randomUUID()}`);
      await writeFile(tmp, bytes);
      await rename(tmp, this.file(key));
      return { etag: etagOf(bytes) };
    });
  }

  delete(key: string): Promise<void> {
    return this.withLock(key, () => rm(this.file(key), { force: true }));
  }

  // Keys ascend in UTF-8 byte order, as R2 lists them; the cursor is the last key of the page.
  async list(options: { prefix: string; cursor?: string; limit?: number }): Promise<ObjectListing> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const keys = (await readdir(this.root))
      .filter((f) => f.endsWith(SUFFIX))
      .map((f) => decodeURIComponent(f.slice(0, -SUFFIX.length)))
      .filter((k) => k.startsWith(options.prefix) && (options.cursor === undefined || Buffer.compare(Buffer.from(k), Buffer.from(options.cursor)) > 0))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const page = keys.slice(0, limit);
    const truncated = keys.length > limit;
    return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: page[page.length - 1] } : {}) };
  }
}

// The blob-storage port every host binds as `env.VAULT`: the subset of Cloudflare R2's bucket API the
// routes use, declared once. R2 satisfies it natively; server/fs-bucket.ts implements it for the Node
// host, and tests/unit/object-bucket-conformance.test.ts runs one suite against both. Routes that need
// less take a `Pick<>` of it, so a test double only has to supply what the route touches.

export interface StoredObject {
  body: ReadableStream;
  etag: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface ObjectConditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}

export interface ObjectListing {
  objects: { key: string }[];
  truncated: boolean;
  cursor?: string;
}

export interface ObjectBucket {
  get(key: string): Promise<StoredObject | null>;
  /** The written object's new etag, or null when an `onlyIf` precondition fails — never a throw. */
  put(key: string, value: string | Uint8Array, options?: { onlyIf?: ObjectConditional }): Promise<{ etag: string } | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<ObjectListing>;
}

/**
 * Every key under a prefix, following the cursor. R2 caps a page at 1000 objects, and reading one page
 * as the whole answer has already cost this project a silent backup failure and a false
 * `complete: true` erasure (W73).
 */
export async function listAllKeys(bucket: Pick<ObjectBucket, "list">, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor ? { prefix, cursor } : { prefix });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

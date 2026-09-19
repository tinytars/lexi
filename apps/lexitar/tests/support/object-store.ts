// In-memory stand-in for scripts/vault-sync.ts's Cloudflare REST R2 client (the network boundary).
// `objects` is keyed `${bucket}::${key}` so tests can seed and inspect across buckets.
export function memoryObjectStore() {
  const objects = new Map<string, Uint8Array>();
  const id = (bucket: string, key: string) => `${bucket}::${key}`;
  return {
    objects,
    getObject: async (bucket: string, key: string) => objects.get(id(bucket, key)) ?? null,
    putObject: async (bucket: string, key: string, body: Uint8Array) => {
      objects.set(id(bucket, key), body);
    },
    listObjects: async (bucket: string, prefix?: string) =>
      [...objects.keys()]
        .filter((k) => k.startsWith(id(bucket, prefix ?? "")))
        .map((k) => ({ key: k.slice(bucket.length + 2), size: objects.get(k)!.length, etag: "x" })),
    deleteObject: async (bucket: string, key: string) => {
      objects.delete(id(bucket, key));
    },
  };
}

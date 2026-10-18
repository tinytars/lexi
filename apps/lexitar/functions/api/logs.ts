import { requireBearer } from "../_lib/guard";
import { json } from "../_lib/http";
import { storeKey } from "../_lib/store";
import type { AuditEntry } from "../_lib/audit";
import type { ObjectBucket } from "../_lib/object-bucket";

// W39/Phase 4 — provider-visible READ side of the refresh audit trail. Lists the per-event R2 objects
// the refresh Function + the client loop beacon persisted (audit.ts writes one small object per event
// under a dated prefix) and returns the newest N, newest-first, so a provider can reconstruct what a
// refresh did AFTER the fact — no live `wrangler pages deployment tail`, no redeploy. PROVIDER_TOKEN-
// gated exactly like /api/refresh-finding + /api/log: the log is operational metadata, still provider-
// only. Returns only the PHI-free entries the writers stored — no client bytes, no prose.

interface Env {
  PROVIDER_TOKEN: string;
  VAULT?: Pick<ObjectBucket, "list" | "get">;
  STORE_PREFIX: string;
}

export type StoredEntry = AuditEntry & { at: string };

const SLUG = /^[a-z0-9-]{1,40}$/; // bounds the listed route prefix — no path traversal into other keys
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const noStore = (status: number, body: unknown): Response => json(status, body, { "cache-control": "no-store" });

export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  if (requireBearer(request, env.PROVIDER_TOKEN)) return noStore(401, { error: "unauthorized" });

  const url = new URL(request.url);
  const route = url.searchParams.get("route") ?? "refresh-finding";
  if (!SLUG.test(route)) return noStore(400, { error: "bad route" });
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));

  // No R2 binding (a local/test env without VAULT) → the trail was console-only, nothing persisted to read.
  if (!env.VAULT) return noStore(200, { entries: [] });
  const bucket = env.VAULT;

  const prefix = storeKey(env, "logs", route);
  // list() is metadata-only (cheap); page through so every day's objects are seen, then fetch only the
  // newest `limit` bodies. Keys are `<prefix>/<yyyy-mm-dd>/<cf-ray>-<seq>.json`, so descending key order
  // is ~newest-first; the exact order comes from the `at` field once the objects are read.
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const newest = keys.sort().reverse().slice(0, limit);
  const entries = (
    await Promise.all(
      newest.map(async (k) => {
        const obj = await bucket.get(k);
        if (!obj) return null;
        try {
          return JSON.parse(await obj.text()) as StoredEntry;
        } catch {
          return null; // a partial/corrupt object never breaks the whole read
        }
      }),
    )
  ).filter((e): e is StoredEntry => e !== null);

  // Exact newest-first by the persisted timestamp (key order is only approximate within a day).
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return noStore(200, { entries });
}

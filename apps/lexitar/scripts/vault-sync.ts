// W6e — keep the on-disk vault slice coherent with R2 (the source of truth).
// pull() before the CLI loads a client, push() after it writes — so a regen never
// runs on a stale slice and never clobbers a web/phone edit that landed in R2.
//
// W13d — every R2 key is namespaced by a per-deployment store prefix ({store}/…) so
// the dev deploy, a future prod deploy, and any branch preview can share one bucket
// without colliding. The CLI's store defaults to STORE_PREFIX (or "dev") and is
// overridable with --store. Mirrors functions/_lib/store.ts storeKey.
//
// Uses the local machine's wrangler account auth (ambient CLOUDFLARE_API_TOKEN) for
// direct bucket access — no Function / VAULT_TOKEN roundtrip. See VAULT.md §7.
//
// NOTE: wrangler r2 defaults to a LOCAL simulated bucket; --remote is required to hit
// the real cloud bucket. pull downloads to a temp file and only swaps it into place on
// success, so a remote miss never truncates the real slice.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { wranglerTarget } from "./target";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, "../records/public");
const PRIVATE_DIR = resolve(here, "../records/private");

// W53 P4: the bucket comes from the worktree's wrangler.jsonc, not a constant. It was hardcoded to
// health-vault, which made prod's bucket unreachable by every tool in here. See scripts/target.ts.
const BUCKET = wranglerTarget().bucket;

// The deployment namespace. Throws on empty, mirroring functions/_lib/store.ts — an empty
// prefix would merge two deployments' keys. Explicit --store wins, else STORE_PREFIX, else the
// branch's own STORE_PREFIX. It used to fall back to the literal "dev", which meant running from
// the main worktree built `dev/…` keys against prod's bucket and silently found nothing.
export function resolveStore(explicit?: string): string {
  const s = (explicit ?? process.env.STORE_PREFIX ?? wranglerTarget().storePrefix).trim();
  if (!s) throw new Error("empty store prefix — refusing to build an unprefixed R2 key");
  return s;
}

// Pure key/ref builders. The vault key matches the slice filename + the Function's r2Key
// (data-{id}.enc) under the store prefix; raw/processed mirror the on-disk records/ layout.
export const r2KeyFor = (store: string, id: string): string => `${store}/data-${id.toLowerCase()}.enc`;
export const r2RawKeyFor = (store: string, id: string, file: string): string => `${store}/raw/${id.toLowerCase()}/${file}`;
export const r2ProcessedKeyFor = (store: string, id: string, sha8: string): string => `${store}/processed/${id.toLowerCase()}/${sha8}.json`;

export const r2RefFor = (store: string, id: string): string => `${BUCKET}/${r2KeyFor(store, id)}`;
export const r2RawRefFor = (store: string, id: string, file: string): string => `${BUCKET}/${r2RawKeyFor(store, id, file)}`;
export const r2ProcessedRefFor = (store: string, id: string, sha8: string): string => `${BUCKET}/${r2ProcessedKeyFor(store, id, sha8)}`;

export const localPathFor = (id: string): string => resolve(PUBLIC_DIR, `data-${id.toLowerCase()}.enc`);
export const localRawDir = (id: string): string => resolve(PRIVATE_DIR, id.toLowerCase(), "raw");

// wrangler arg arrays — exported so the contract is unit-testable without shelling out.
// --remote is load-bearing: without it wrangler reads/writes a local miniflare bucket.
export const pullArgs = (store: string, id: string, file: string): string[] =>
  ["wrangler", "r2", "object", "get", r2RefFor(store, id), "--remote", "--file", file];
export const pushArgs = (store: string, id: string): string[] =>
  ["wrangler", "r2", "object", "put", r2RefFor(store, id), "--remote", "--file", localPathFor(id)];

const isMissing = (stderr: string): boolean => /specified key does not exist/i.test(stderr);

export type PullResult = "pulled" | "missing";

// ─────────────────────────────────────────────────────────────────────────────
// W76 — the operator's half of W70's concurrency guarantee.
//
// W70 stopped two browsers from overwriting each other: functions/api/vault/[id].ts:109 REQUIRES an
// If-Match on the session path, because a vault write carries the WHOLE record, so the loser does not
// lose a field — it loses every edit since unlock, while being shown "✓ saved". That guarantee never
// reached the CLI. `push()` shells to `wrangler r2 object put`, which has no conditional option and
// writes straight to the bucket, so an operator sync silently clobbered a browser save that landed
// after the CLI's pull.
//
// This is compare-and-swap, NOT the atomic precondition the browsers get, and the difference is worth
// stating rather than glossing: the etag is re-read immediately before the write, so a save landing
// inside that window is still lost. Closing it entirely means either a conditional PUT through the
// REST layer below or a VAULT_TOKEN roundtrip through the Function — the second is what this module's
// header deliberately avoids. What it does buy is that the ordinary case, an operator working from a
// slice pulled minutes or hours ago, now REFUSES instead of winning.
// ─────────────────────────────────────────────────────────────────────────────

/** The etag each vault key had when this process last read it. `null` = the object did not exist. */
const readEtags = new Map<string, string | null>();

export type PushDecision = "create" | "replace" | "conflict";

/**
 * `pulled` is what we read; `current` is what is there now. `undefined` means this run never read the
 * vault at all, which is the loudest case rather than the quietest: a push that carries a whole record
 * the process never loaded is the clobber this guard exists to stop, not an exemption from it.
 */
export function pushDecision(pulled: string | null | undefined, current: string | null): PushDecision {
  if (pulled === undefined) return "conflict";
  if (pulled === null) return current === null ? "create" : "conflict";
  return pulled === current ? "replace" : "conflict";
}

export function describePushConflict(id: string, pulled: string | null | undefined, current: string | null): string {
  if (pulled === undefined) return `refusing to push "${id}" — this run never read it, so it cannot know what it would overwrite`;
  if (pulled === null) return `refusing to push "${id}" — it did not exist when this run started and does now; something else created it`;
  if (current === null) return `refusing to push "${id}" — the object this run read has been deleted`;
  return `refusing to push "${id}" — R2 moved since this run read it (${pulled} → ${current}). Pull again and redo the edit; pushing would discard whatever landed in between`;
}

// R2 -> disk. Downloads to a temp file first; only swaps it into place on success, so an
// R2 miss (or any error) leaves the existing on-disk slice untouched. Miss is a no-op
// (bucket not seeded yet). Auth/network failure throws — better than running on stale data.
export async function pull(id: string, store = resolveStore()): Promise<PullResult> {
  const dest = localPathFor(id);
  const tmp = `${dest}.r2tmp`;
  try {
    await execFileAsync("npx", pullArgs(store, id, tmp), { cwd: resolve(here, "..") });
    await rename(tmp, dest);
    readEtags.set(r2KeyFor(store, id), await currentEtag(store, id));
    return "pulled";
  } catch (e) {
    await rm(tmp, { force: true });
    const stderr = String((e as { stderr?: unknown }).stderr ?? (e as Error).message ?? "");
    if (isMissing(stderr)) {
      readEtags.set(r2KeyFor(store, id), null);
      return "missing";
    }
    throw new Error(`vault pull failed for "${id}" (R2 may be unreachable; use --no-sync for offline work):\n${stderr}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// "No workstation writes the deployed vault" — the guard rather than the paragraph.
//
// CLAUDE.md has held this line in prose since W77 and says outright that it wants a guard, because
// prose only catches the careful case. The hazard is specific and already documented above: the
// operator push re-reads the etag immediately before the write and STILL cannot close the window, a
// laptop run leaves no audit trail, and `concurrency: vault-{client}` can only serialize the runs
// GitHub can see.
//
// Scoped to the LIVE bucket deliberately. BACKUP_BUCKET writes stay open because snapshot-cron.sh is
// kept as the one path that works when GitHub does not, and a backup write cannot clobber live data.
// Reads are never guarded — inspection is one of the four things that stay local by design.
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_WRITE_OVERRIDE = "PLOVER_ALLOW_LOCAL_VAULT_WRITE";

export function liveWriteRefusal(what: string): string {
  return (
    `refusing to write ${what} from a workstation.\n` +
    `  This writes the deployed vault, so it goes through .github/workflows/ops.yml, which serializes\n` +
    `  it with concurrency: vault-{client} and leaves an audit trail a local run does not.\n` +
    `  If this is the unreachable-GitHub emergency the rule allows for, set ${LOCAL_WRITE_OVERRIDE}=1.`
  );
}

/** Throws unless this is CI, or the operator has explicitly and loudly taken responsibility. */
export function assertLiveWriteAllowed(what: string): void {
  if (process.env.CI) return;
  if (process.env[LOCAL_WRITE_OVERRIDE]) {
    process.stderr.write(
      `\n!! ${LOCAL_WRITE_OVERRIDE} is set — writing ${what} from this workstation, outside ops.yml.\n` +
        `!! No concurrency guard and no audit trail: a browser save landing right now is lost silently.\n\n`,
    );
    return;
  }
  throw new Error(liveWriteRefusal(what));
}

// disk -> R2. Failure throws loudly: R2 was NOT updated, so disk and R2 now diverge.
export async function push(id: string, store = resolveStore()): Promise<void> {
  assertLiveWriteAllowed(`the deployed vault for "${id}"`);
  const key = r2KeyFor(store, id);
  const current = await currentEtag(store, id);
  const pulled = readEtags.get(key);
  if (pushDecision(pulled, current) === "conflict") throw new Error(describePushConflict(id, pulled, current));
  try {
    await execFileAsync("npx", pushArgs(store, id), { cwd: resolve(here, "..") });
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? (e as Error).message ?? "");
    throw new Error(`vault push failed for "${id}" — R2 NOT updated, divergence risk:\n${stderr}`);
  }
  // What we just wrote is now what this run has read, so a second push in the same run is not a
  // conflict with itself.
  readEtags.set(key, await currentEtag(store, id));
}

// R2 -> an arbitrary path (W15/2b --reconcile: pull the authoritative vault .enc to a temp
// file so it can be decrypted + compared WITHOUT overwriting the committed records/public
// slice — a no-op reconcile must leave the working tree clean).
export async function pullVaultTo(id: string, destPath: string, store = resolveStore()): Promise<PullResult> {
  const tmp = `${destPath}.r2tmp`;
  try {
    await execFileAsync("npx", pullArgs(store, id, tmp), { cwd: resolve(here, "..") });
    await rename(tmp, destPath);
    readEtags.set(r2KeyFor(store, id), await currentEtag(store, id));
    return "pulled";
  } catch (e) {
    await rm(tmp, { force: true });
    const stderr = String((e as { stderr?: unknown }).stderr ?? (e as Error).message ?? "");
    if (isMissing(stderr)) {
      readEtags.set(r2KeyFor(store, id), null);
      return "missing";
    }
    throw new Error(`vault pull-to-path failed for "${id}":\n${stderr}`);
  }
}

// R2 -> disk, one raw original (W15/2 --process-pending: fetch a browser-uploaded raw
// so the CLI can parse + fold it). Downloads to a temp file, swaps on success; a miss
// (browser PUT never landed) is a no-op the caller skips.
export const pullRawArgs = (store: string, id: string, file: string, destFile: string): string[] =>
  ["wrangler", "r2", "object", "get", r2RawRefFor(store, id, file), "--remote", "--file", destFile];

export async function pullRaw(store: string, id: string, file: string, destPath: string): Promise<PullResult> {
  const tmp = `${destPath}.r2tmp`;
  try {
    await execFileAsync("npx", pullRawArgs(store, id, file, tmp), { cwd: resolve(here, "..") });
    await rename(tmp, destPath);
    return "pulled";
  } catch (e) {
    await rm(tmp, { force: true });
    const stderr = String((e as { stderr?: unknown }).stderr ?? (e as Error).message ?? "");
    if (isMissing(stderr)) return "missing";
    throw new Error(`raw pull failed for "${id}/${file}":\n${stderr}`);
  }
}

// disk -> R2, one raw original. Used by the cutover migration and by ingest going forward
// so /api/raw can serve it. Plaintext PHI lands under {store}/raw/{id}/ (bearer-gated GET).
export async function pushRaw(store: string, id: string, file: string, absPath: string): Promise<void> {
  assertLiveWriteAllowed(`${store}/raw/${id.toLowerCase()}/${file}`);
  const args = ["wrangler", "r2", "object", "put", r2RawRefFor(store, id, file), "--remote", "--file", absPath];
  try {
    await execFileAsync("npx", args, { cwd: resolve(here, "..") });
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? (e as Error).message ?? "");
    throw new Error(`raw push failed for "${id}/${file}" — R2 NOT updated:\n${stderr}`);
  }
}

// Delete one R2 object by full ref (BUCKET/key). Used by --remove-source to expunge the
// raw original + processed artifact from the bucket. A missing key is treated as success
// (idempotent removal — the goal is "it is gone", not "it was there").
async function deleteRef(ref: string): Promise<void> {
  assertLiveWriteAllowed(ref);
  const args = ["wrangler", "r2", "object", "delete", ref, "--remote"];
  try {
    await execFileAsync("npx", args, { cwd: resolve(here, "..") });
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? (e as Error).message ?? "");
    if (isMissing(stderr)) return;
    throw new Error(`R2 delete failed for "${ref}":\n${stderr}`);
  }
}

export const deleteRaw = (store: string, id: string, file: string): Promise<void> =>
  deleteRef(r2RawRefFor(store, id, file));
export const deleteProcessed = (store: string, id: string, sha8: string): Promise<void> =>
  deleteRef(r2ProcessedRefFor(store, id, sha8));

// ─────────────────────────────────────────────────────────────────────────────
// W52 §REST — bulk R2 access for the snapshot/restore tooling.
//
// Everything above shells to `wrangler r2 object`, which is the right tool for the
// one-key-at-a-time pull/push the CLI does around a single client. It cannot serve a
// backup: wrangler has NO `r2 object list` subcommand, and one `npx wrangler` spawn per
// object is untenable at snapshot scale (the live dev store is already ~1250 objects).
//
// So bulk work goes through the Cloudflare REST API — same account, same ambient
// CLOUDFLARE_API_TOKEN wrangler itself uses (scripts/wrangler.sh / load-creds.ts), no new
// credential. It stays in THIS file so there is still exactly one module that knows how to
// reach the bucket, per W52 ("extend vault-sync.ts, do not fork an R2 client").
// ─────────────────────────────────────────────────────────────────────────────

const CF_API = "https://api.cloudflare.com/client/v4";
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 6;

// W53 P4 / W75 — derived per worktree like every other target, not a constant. See scripts/target.ts.
export const BACKUP_BUCKET = wranglerTarget().backupBucket;
export const LIVE_BUCKET = BUCKET;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The Cloudflare API rate-limits an account globally (~1200 requests / 5 min). A snapshot is
// inherently request-heavy — one round trip per object — and unthrottled it trips a 429 partway
// through, which is exactly the half-finished backup this milestone exists to prevent. So every
// call goes through one process-wide token bucket sized well under the ceiling; retries then only
// have to absorb real transients, not our own burst. CF_API_RPS overrides it for a one-off catch-up.
const RPS = Number(process.env.CF_API_RPS ?? 3);
let nextSlot = 0;

async function takeSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / RPS;
  if (at > now) await sleep(at - now);
}

function apiAuth(): { accountId: string; token: string } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN unset — import scripts/load-creds, or source the " +
        "the operator's private cloudflare.env (see scripts/creds.sh).",
    );
  }
  return { accountId, token };
}

// Each key segment is percent-encoded but "/" stays a real path separator, so a key with a
// space or "#" in a raw filename round-trips instead of silently addressing a different object.
const objectPath = (bucket: string, key: string): string =>
  `/r2/buckets/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;

// Retries transient failures (5xx/429 and network errors) with backoff. A backup that half-fails
// is the failure mode this milestone exists to remove, so the final attempt throws — never a
// silent partial success.
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { accountId, token } = apiAuth();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let retryAfterMs = 0;
    try {
      await takeSlot();
      const res = await fetch(`${CF_API}/accounts/${accountId}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
      });
      if (res.ok || !RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) return res;
      lastErr = new Error(`HTTP ${res.status}`);
      const hdr = Number(res.headers.get("retry-after"));
      retryAfterMs = Number.isFinite(hdr) && hdr > 0 ? hdr * 1000 : 0;
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_ATTEMPTS) throw e;
    }
    await sleep(Math.max(retryAfterMs, 500 * 2 ** attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface R2ObjectInfo {
  key: string;
  size: number;
  etag: string;
  uploaded?: string;
}

export async function listObjects(bucket: string, prefix?: string): Promise<R2ObjectInfo[]> {
  const out: R2ObjectInfo[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ per_page: "1000" });
    if (prefix) qs.set("prefix", prefix);
    if (cursor) qs.set("cursor", cursor);
    const res = await apiFetch(`/r2/buckets/${encodeURIComponent(bucket)}/objects?${qs}`);
    if (!res.ok) throw new Error(`R2 list failed for ${bucket} (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as {
      result: Array<{ key: string; size: number | string; etag: string; uploaded?: string }>;
      result_info?: { cursor?: string };
    };
    for (const o of body.result) out.push({ key: o.key, size: Number(o.size), etag: o.etag, uploaded: o.uploaded });
    cursor = body.result_info?.cursor || undefined;
  } while (cursor);
  return out;
}

// null on a genuine miss; any other non-2xx throws (a 403 must not read as "no such object").
export async function getObject(bucket: string, key: string): Promise<Uint8Array | null> {
  const res = await apiFetch(objectPath(bucket, key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 get failed for ${bucket}/${key} (${res.status}): ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function putObject(bucket: string, key: string, body: Uint8Array): Promise<void> {
  if (bucket === LIVE_BUCKET) assertLiveWriteAllowed(`${bucket}/${key}`);
  const res = await apiFetch(objectPath(bucket, key), {
    method: "PUT",
    // BodyInit only admits Uint8Array<ArrayBuffer>; ours is Uint8Array<ArrayBufferLike> because it
    // may come from a SharedArrayBuffer-capable source. Runtime-identical, lib-types artifact only.
    body: body as unknown as BodyInit,
    headers: { "content-type": "application/octet-stream" },
  });
  if (!res.ok) throw new Error(`R2 put failed for ${bucket}/${key} (${res.status}): ${await res.text()}`);
}

// Idempotent: a missing key is success (the goal is "it is gone", matching deleteRef above).
export async function deleteObject(bucket: string, key: string): Promise<void> {
  if (bucket === LIVE_BUCKET) assertLiveWriteAllowed(`${bucket}/${key}`);
  const res = await apiFetch(objectPath(bucket, key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 delete failed for ${bucket}/${key} (${res.status}): ${await res.text()}`);
  }
}

/** The live etag of one vault key, or null when there is no such object. */
export async function currentEtag(store: string, id: string): Promise<string | null> {
  const key = r2KeyFor(store, id);
  const hits = await listObjects(LIVE_BUCKET, key);
  return hits.find((o) => o.key === key)?.etag ?? null;
}

export async function bucketExists(bucket: string): Promise<boolean> {
  const res = await apiFetch(`/r2/buckets/${encodeURIComponent(bucket)}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`R2 bucket lookup failed for ${bucket} (${res.status}): ${await res.text()}`);
  return true;
}

// The inverse of the r2*KeyFor builders above: what class of live data is this key?
// `null` means "a key shape this tool has never been taught about" — the snapshot treats that
// as a hard error rather than skipping it, so a new key class added to storeKey() elsewhere
// cannot silently fall out of the backup.
export type KeyClass = "vault" | "chat" | "raw" | "processed" | "text" | "logs";

export function classifyKey(store: string, key: string): KeyClass | null {
  if (!key.startsWith(`${store}/`)) return null;
  const rest = key.slice(store.length + 1);
  if (/^data-[^/]+\.enc$/.test(rest)) return "vault";
  if (/^chat-[^/]+\.enc$/.test(rest)) return "chat";
  if (/^raw\/.+/.test(rest)) return "raw";
  if (/^processed\/.+/.test(rest)) return "processed";
  // W46 document-extract writes a text-extraction sidecar per attachment (document-extract.ts:98).
  // It is a CACHE, but it is derived from plaintext PHI and lives in the vault bucket, so it is
  // backed up like everything else rather than skipped.
  if (/^text\/.+/.test(rest)) return "text";
  if (/^logs\/.+/.test(rest)) return "logs";
  return null;
}

// Bounded-concurrency map. R2 REST is per-object, so a snapshot is ~1250 round trips; serial is
// minutes, unbounded parallel gets rate-limited. Preserves input order in the result.
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

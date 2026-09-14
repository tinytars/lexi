// W53 P4 — resolve WHICH environment a script acts on from the worktree's wrangler.jsonc.
//
// Every script here used to hardcode `health-vault` / `health-identity-dev`, which made prod
// unreachable by any tool. That was fine while dev was the only real deployment; it stopped being
// fine at the cutover, where CUTOVER.md step 5 ("decrypt every blob in prod") has to read prod's
// bucket and prod's D1 and there was nothing that could.
//
// The rule is the one scripts/d1-migrate.sh already established: `wrangler.jsonc` is deliberately
// divergent per branch, so "which database" and "which bucket" only have an answer relative to a
// branch. THE WORKTREE YOU STAND IN DECIDES. Deriving it here means a prod operation run from the
// dev worktree targets dev — loudly wrong in the direction that is safe — rather than silently
// mixing the two.
//
// Env vars override, for the rare deliberate cross-target run. They are named after the wrangler
// bindings so an override is obvious in a shell history.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const WRANGLER_JSONC = resolve(here, "../wrangler.jsonc");

export interface Target {
  bucket: string;
  /**
   * W75 — the backup bucket, derived from the live one rather than a constant.
   *
   * It WAS a constant (`health-vault-backup` in vault-sync.ts), outside this module's per-worktree
   * resolution entirely. The retention prune lists that bucket globally and deletes everything past
   * `--keep`, so the first prod snapshot and the dev nightly would have shared one namespace: dev's
   * fresher timestamps would have won the sort and prod's only backups would have been deleted, by
   * the job whose purpose is to protect them.
   */
  backupBucket: string;
  database: string;
  databaseId: string;
  storePrefix: string;
  /** Where each value came from, so a script can name its target before acting on it. */
  source: "wrangler.jsonc" | "env" | "mixed";
}

let cached: Target | undefined;

export function wranglerTarget(): Target {
  if (cached) return cached;

  // Strip whole-line // comments so JSON.parse can read the JSONC — same treatment as
  // scripts/d1-migrate.sh and the gate's own wrangler check.
  const raw = readFileSync(WRANGLER_JSONC, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
  const cfg = JSON.parse(raw);

  const fromFile = {
    bucket: cfg.r2_buckets?.[0]?.bucket_name,
    database: cfg.d1_databases?.[0]?.database_name,
    databaseId: cfg.d1_databases?.[0]?.database_id,
    storePrefix: cfg.vars?.STORE_PREFIX,
  };

  for (const [k, v] of Object.entries(fromFile)) {
    if (!v) throw new Error(`target: wrangler.jsonc is missing ${k} — cannot tell which environment to act on`);
  }

  const overrides = {
    bucket: process.env.VAULT_BUCKET,
    database: process.env.D1_DATABASE,
    databaseId: undefined,
    storePrefix: process.env.STORE_PREFIX,
  };

  const overridden = Object.entries(overrides).some(([k, v]) => v && v !== (fromFile as Record<string, string>)[k]);

  const bucket = overrides.bucket || fromFile.bucket;
  cached = {
    bucket,
    backupBucket: `${bucket}-backup`,
    database: overrides.database || fromFile.database,
    databaseId: fromFile.databaseId,
    storePrefix: overrides.storePrefix || fromFile.storePrefix,
    source: overridden ? "mixed" : "wrangler.jsonc",
  };
  return cached;
}

/** One line naming the target, for a script to print before it touches anything remote. */
export function describeTarget(): string {
  const t = wranglerTarget();
  const via = t.source === "wrangler.jsonc" ? "wrangler.jsonc" : "wrangler.jsonc + env override";
  return `target: bucket=${t.bucket} backup=${t.backupBucket} db=${t.database} store=${t.storePrefix} (via ${via})`;
}

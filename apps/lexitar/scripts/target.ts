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

/**
 * Which environment one target field names, by suffix — `health-vault-prod`, `health-identity-prod`,
 * `prod`. Anything else is dev, which is the safe direction to be wrong in: a dev verdict on a prod
 * name mismatches the other two fields and refuses, where the reverse would pass silently.
 */
export const envOf = (value: string): "prod" | "dev" => (/(^|-)prod$/.test(value) ? "prod" : "dev");

/** The refusal text when bucket, database and store prefix do not name one environment, else null. */
export function targetMismatch(t: { bucket: string; database: string; storePrefix: string }): string | null {
  const seen = { bucket: envOf(t.bucket), database: envOf(t.database), "store prefix": envOf(t.storePrefix) };
  if (new Set(Object.values(seen)).size === 1) return null;
  const named = Object.entries(seen).map(([k, v]) => `${k} names ${v}`).join(", ");
  return (
    `refusing to act on a target whose halves disagree — ${named}.\n` +
    `bucket=${t.bucket} db=${t.database} store=${t.storePrefix}\n` +
    `A cross-target run overrides VAULT_BUCKET, D1_DATABASE and STORE_PREFIX together; one without ` +
    `the others is this same trap. As it stands, one store's objects would be read against the other ` +
    `store's rows.`
  );
}

/**
 * The refusal, for a command that is about to touch a live store.
 *
 * It is NOT inside `wranglerTarget()`, and that is deliberate rather than an omission. `vault-sync.ts`
 * resolves `BACKUP_BUCKET` and `LIVE_BUCKET` at module scope, so a throw in the resolver would be a
 * throw at IMPORT time — breaking any test or tool that merely loads the module under an odd
 * environment, with a stack trace that names neither the variable nor the fix. A command calls this
 * where it can say what it was about to do.
 *
 * The trap it closes was measured, not imagined: a `main` checkout with `STORE_PREFIX=dev` reads
 * prod's backup bucket under a dev-shaped key, and on 2026-10-06 that answered
 * `BACKUP ALARM — newest snapshot is 410.3h old` for a store whose backup was in fact current. A
 * false alarm is the cheap version. The dear version is a sweep that subtracts one store's claimed
 * keys from the other store's listing and calls the difference abandoned.
 */
export function assertTargetConsistent(effectiveStore?: string): void {
  const t = wranglerTarget();
  // The effective store is the caller's, not this module's: vault-snapshot.ts takes `--store`, which
  // `wranglerTarget()` cannot see and which is one of the two ways into the trap above.
  const m = targetMismatch({ ...t, storePrefix: effectiveStore ?? t.storePrefix });
  if (m) throw new Error(m);
}

/**
 * Which environment a DEPLOY BRANCH owns, or null where the branch declares none.
 *
 * This is the fourth input, and the one `envOf` structurally cannot see: it reads a field out of
 * `wrangler.jsonc`, and `wrangler.jsonc` is the same file on either branch. A whole-file swap keeps
 * every field agreeing with every other field, so `targetMismatch` passes it — and it is the branch
 * the file sits on that is wrong.
 */
export const envOfBranch = (branch: string): "prod" | "dev" | null =>
  branch === "main" ? "prod" : branch === "dev" ? "dev" : null;

/**
 * The refusal text when `wrangler.jsonc` names an environment the branch does not own, else null.
 *
 * MEASURED, and the measurement is why this exists. A Dependabot SECURITY update is raised against
 * the DEFAULT branch whatever `dependabot.yml`'s `target-branch` says, so it is cut from `main` and
 * carries main's `wrangler.jsonc`. The autopilot host already knows this and retargets such a pull
 * request onto `dev`, then asks Dependabot to rebase it there
 * (.github/workflows/claude-review.yml) — but the retarget lands immediately and the rebase may not
 * land at all. #181 and #182 sat retargeted-and-unrebased from 2026-10-06 to 2026-10-07, each
 * proposing `health-vault-prod` / `health-identity-prod` / `prod` to `dev`, which would have bound
 * dev's Pages deployment to the production bucket and database. Both are patch bumps, and
 * `no-review-update-types: minor,patch` merges those on green CI with no model call.
 *
 * Nothing else caught it. `tests/unit/vault-sync.test.ts` asserts the three fields sit on one side
 * of the dev/prod split, and they did — main's file is internally consistent. The build succeeds,
 * the bindings resolve, and the only wrong thing is which store the writes land in.
 */
export function branchMismatch(
  branch: string,
  t: { bucket: string; database: string; storePrefix: string },
): string | null {
  const want = envOfBranch(branch);
  if (!want) return null;
  const seen = { bucket: envOf(t.bucket), database: envOf(t.database), "store prefix": envOf(t.storePrefix) };
  const wrong = Object.entries(seen).filter(([, v]) => v !== want);
  if (!wrong.length) return null;
  const named = wrong.map(([k, v]) => `${k} names ${v}`).join(", ");
  return (
    `refusing a tree whose wrangler.jsonc names an environment this branch does not own — ` +
    `branch ${branch} owns ${want}, but ${named}.\n` +
    `bucket=${t.bucket} db=${t.database} store=${t.storePrefix}\n` +
    `wrangler.jsonc is deliberately divergent per branch and Cloudflare Pages reads it on every ` +
    `build, overriding the dashboard — so a branch's copy IS its environment. Merging this would ` +
    `point ${branch}'s deployment at ${wrong[0][1]}'s store.`
  );
}

/**
 * Which environment a BASE URL names, or null where the host is not one of this product's.
 *
 * The fifth input, and the only one that is not in the tree at all. `targetMismatch` and
 * `branchMismatch` both read the worktree — the file, then the branch the file sits on — and a
 * script's `LEXITAR_BASE_URL` is neither: it is typed on the command line at the moment of use and
 * nothing cross-checks it, so the dev worktree reaches production by one variable and no refusal.
 *
 * `either` rather than `dev` for localhost, because `npm run dev:functions` is run from both
 * worktrees and binds whichever `wrangler.jsonc` it was started with — the local server IS the
 * worktree's environment, so it cannot disagree with it.
 */
export function envOfBaseUrl(baseUrl: string): "prod" | "dev" | "either" | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) return "either";
  if (host === "literacy.tinytars.foundation") return "prod";
  // A Pages hostname is `<project>.pages.dev`, and a PREVIEW prefixes it with a branch or commit
  // label — `abc1234.health-dash-dev.pages.dev`. So the project is the label immediately before
  // `pages.dev` and never the first one, which is what a naive `startsWith` would read.
  if (host.endsWith(".pages.dev")) {
    const project = host.slice(0, -".pages.dev".length).split(".").pop();
    if (project === "health-dash-main") return "prod";
    if (project === "health-dash-dev" || project === "health-dash-aex") return "dev";
  }
  return null;
}

/**
 * The refusal text when the base URL names an environment the worktree does not, else null.
 *
 * An UNRECOGNISED host is deliberately not a refusal. The incident this closes is a recognised
 * production origin reached from a dev tree (or the reverse), and an unknown host cannot be either
 * deployment — refusing it would only break a test harness or a tunnel while catching nothing. The
 * same "safe direction" reasoning `envOf` is written under: this guard's job is disagreement, and
 * disagreement needs both halves named.
 */
export function baseUrlMismatch(
  baseUrl: string,
  t: { bucket: string; database: string; storePrefix: string },
): string | null {
  const seen = envOfBaseUrl(baseUrl);
  if (seen === null || seen === "either") return null;
  const want = envOf(t.database);
  if (seen === want) return null;
  return (
    `refusing a request aimed at ${seen} from a worktree bound to ${want} — ` +
    `LEXITAR_BASE_URL=${baseUrl}.\n` +
    `bucket=${t.bucket} db=${t.database} store=${t.storePrefix}\n` +
    `The base URL picks the DEPLOYMENT, the worktree's wrangler.jsonc picks the STORE, and nothing ` +
    `else compares them. Stand in the worktree whose branch owns ${seen} and run it there.`
  );
}

/** The refusal, for a script about to sign in to a deployment. Called where the base URL is read. */
export function assertBaseUrlMatchesTarget(baseUrl: string): void {
  const m = baseUrlMismatch(baseUrl, wranglerTarget());
  if (m) throw new Error(m);
}

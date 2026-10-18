// Where readable medical data is allowed to land, enforced when it lands rather than by an ignore rule.
//
// A .gitignore entry is the wrong control for two reasons: this repo is public, and its own ignore
// file RE-INCLUDES `records/**` — the one directory an operator would reach for. So the guard is a
// run-time refusal instead: an export path inside any git work tree, or anywhere under `records/`, is
// refused outright and there is no --force.
//
// The destination is per-user state, not a repo, not a temp dir and not the CI runner: 0700 under
// $XDG_STATE_HOME so it survives a reboot long enough to be analysed and is removable by one command
// the run itself prints.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, parse, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const RECORDS_DIR = resolve(here, "../records");

export function exportRoot(): string {
  if (process.env.LEXI_EXPORT_DIR) return resolve(process.env.LEXI_EXPORT_DIR);
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "lexitar", "exports");
}

/** Refuses a destination that git could ever see, naming the tree it found. */
export function assertOutsideRepos(path: string): void {
  const full = resolve(path);
  if (full === RECORDS_DIR || full.startsWith(`${RECORDS_DIR}/`)) {
    throw new Error(`refusing to export into ${RECORDS_DIR} — .gitignore re-includes records/** and this repo is public`);
  }
  for (let dir = full; dir !== parse(dir).root; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      throw new Error(
        `refusing to export into the git work tree at ${dir} — readable PHI must not be somewhere git can stage it`,
      );
    }
  }
}

export function runStamp(now: Date = new Date()): string {
  return `${now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}`;
}

/** Creates and returns this run's directory, 0700 all the way down. */
export function runDir(vaultId: string, now: Date = new Date()): string {
  const dir = join(exportRoot(), `${vaultId}-${runStamp(now)}`);
  assertOutsideRepos(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Removes exported runs — all of them, or those older than `olderThanMs`. Returns what it removed. */
export function purge(olderThanMs?: number): string[] {
  const root = exportRoot();
  if (!existsSync(root)) return [];
  const cutoff = olderThanMs === undefined ? undefined : Date.now() - olderThanMs;
  const removed: string[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (cutoff !== undefined && statSync(dir).mtimeMs > cutoff) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

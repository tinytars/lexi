// One remote D1 query against this worktree's database (scripts/target.ts), as parsed rows.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { wranglerTarget } from "./target";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..");
const WRANGLER = resolve(here, "wrangler.sh");

export const D1 = wranglerTarget().database;

/** SQL string literal. Values here come from D1/R2 listings and operator flags, never from a request. */
export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function d1<T>(sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("bash", [WRANGLER, "d1", "execute", D1, "--remote", "--json", "--command", sql], {
    cwd: APP,
    maxBuffer: 128 * 1024 * 1024,
  });
  return (JSON.parse(stdout) as Array<{ results: T[] }>)[0].results;
}

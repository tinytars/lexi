import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "../../functions/_lib/identity-types";

const DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/**
 * Applies every migration, in order, to a fresh Miniflare D1.
 *
 * Read from the DIRECTORY rather than from a list, because the list was the bug: twenty-one test
 * files each named the migrations they happened to need, so W71's session-revocation migration
 * reached none of them and every session-gated route test failed on a missing column at once. A
 * hand-maintained subset of the schema is a copy of the schema, and it goes stale the same way every
 * other copy in this codebase has.
 *
 * Seed data (0002) is skipped: it inserts specific accounts, which is fixture material a test should
 * choose for itself, not schema.
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql") && !f.includes("seed"))
    .sort();
  for (const f of files) {
    const sql = readFileSync(DIR + f, "utf8").replace(/^\s*--.*$/gm, "");
    for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }
}

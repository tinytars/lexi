import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "../../functions/_lib/identity-types";

const DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Applies every schema migration in directory order — never a hand-picked subset, which goes stale
// as soon as a migration is added. Seed files are skipped: fixtures are the test's choice.
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

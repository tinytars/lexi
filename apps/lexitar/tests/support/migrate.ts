import type { D1Database } from "../../functions/_lib/identity-types";
import { migrations } from "../../server/migrations";

// Schema only: fixtures are the test's choice, so seed files are skipped.
export async function applyMigrations(db: D1Database): Promise<void> {
  for (const { sql } of migrations({ seeds: false })) {
    for (const stmt of sql.replace(/^\s*--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }
}

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SqliteD1Database } from "./sqlite-d1";

const DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface Migration {
  name: string;
  sql: string;
}

// Every migrations/*.sql in directory order — never a hand-picked subset, which goes stale as soon as
// a migration is added. `seeds: false` drops the seed files, for callers whose fixtures are their own.
export function migrations({ seeds }: { seeds: boolean }): Migration[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql") && (seeds || !f.includes("seed")))
    .sort()
    .map((name) => ({ name, sql: readFileSync(DIR + name, "utf8") }));
}

// What `wrangler d1 migrations apply` does for the Cloudflare host: each file not yet recorded in
// d1_migrations runs once, in its own transaction, seeds included.
export function applyPendingMigrations(sqlite: SqliteD1Database): string[] {
  const { db } = sqlite;
  db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const done = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((r) => r.name as string));
  const pending = migrations({ seeds: true }).filter((m) => !done.has(m.name));
  for (const m of pending) {
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(m.name);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
    }
  }
  return pending.map((m) => m.name);
}

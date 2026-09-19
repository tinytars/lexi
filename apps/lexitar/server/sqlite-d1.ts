import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement } from "../functions/_lib/identity-types";

// The D1Database port (vault's structural type) over node:sqlite. D1 *is* SQLite, so every query and
// migrations/*.sql run unchanged; this file only bridges the calling convention. What it must match
// is pinned against real workerd D1 by tests/unit/d1-conformance.test.ts, not assumed.

function toSqlite(value: unknown): SQLInputValue {
  if (value === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

class SqliteStatement implements D1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}

  private statement(): StatementSync {
    return this.db.prepare(this.sql);
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteStatement(this.db, this.sql, values.map(toSqlite));
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.statement().get(...this.params) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: true }> {
    return { results: this.statement().all(...this.params) as T[], success: true };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const r = this.statement().run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  // D1 returns row results for every statement in a batch; a reader returns rows, a writer none.
  execForBatch(): { results: unknown[]; success: true } {
    const s = this.statement();
    if (s.columns().length) return { results: s.all(...this.params), success: true };
    s.run(...this.params);
    return { results: [], success: true };
  }
}

export class SqliteD1Database implements D1Database {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteStatement(this.db, query);
  }

  // D1 runs a batch as one implicit transaction: all statements land, or none do.
  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((s) => (s as SqliteStatement).execForBatch());
      this.db.exec("COMMIT");
      return results;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}

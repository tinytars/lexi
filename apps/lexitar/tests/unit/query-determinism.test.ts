// An `ORDER BY` a hosted route sends to D1 must be a TOTAL order.
//
// `ownerOfClientNamespace` ordered by `created_at` alone and took one row. `created_at` is an ISO
// string at millisecond resolution, so two rows in one namespace routinely tie — the two inserts
// behind a single upload share a millisecond on any quick host — and a tie leaves the answer to the
// query PLAN rather than to a rule. That stayed invisible until the plan changed underneath it:
// converting the prefix match from a `LIKE` to a range (functions/_lib/key-range.ts) turned a table
// scan, which answers in insertion order, into a SEARCH of the `r2_key` index, which answers in key
// order. The owner flipped from the patient to whoever happened to own the alphabetically first
// filename, and because the owner branch deliberately records no disclosure, a clinician's read of
// their patient's file stopped being audited. It failed in CI and passed locally, both hosts tying
// and disagreeing about which row came first — which is the signature of this whole class.
//
// The rule was already written down, in `listRecentAccessEventsForSubject`'s own doc comment, and
// its neighbour three functions away did not have it. That is the argument for a sweep rather than a
// third comment: one query carrying the lesson protects one query.
//
// A total order also matters without `LIMIT 1`. A paged `ORDER BY created_at DESC LIMIT ?` whose
// ties are broken by the plan can show one row twice and another never, across two pages of the same
// list — the same defect, read by a person instead of by a branch.
//
// Scope is `functions/` — the code a request reaches. The operator scripts under `scripts/` are
// deliberately out: several of them order by a column that is unique only within their own `WHERE`
// (one account's credential methods, one vault's envelopes), and a guard that cannot see the
// predicate would be asserting something false about them.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");

/** Source with its comments removed: this suite is about what is SENT, and prose quotes SQL freely. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function filesUnder(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

/**
 * The columns that make an ordering total, per table, read from the migrations rather than listed
 * here — a guard holding a copy of the schema is a guard that agrees with the schema it was written
 * against. Single-column `PRIMARY KEY`/`UNIQUE` declarations and single-column unique indexes count;
 * a composite key does not (one of its columns alone is not unique), and neither does a PARTIAL
 * unique index, which says nothing about the rows outside its `WHERE`.
 */
function uniqueColumnsByTable(): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  const add = (table: string, col: string) => {
    const set = byTable.get(table) ?? new Set<string>();
    // Every table here is a rowid table — none is declared WITHOUT ROWID — so `rowid` is always a
    // valid final tie-break, and it is the one that means "insertion order".
    set.add("rowid");
    set.add(col);
    byTable.set(table, set);
  };
  for (const file of filesUnder(resolve(ROOT, "migrations"), ".sql")) {
    const sql = readFileSync(file, "utf8");
    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\)/gi)) {
      const [, table, body] = m;
      byTable.set(table, byTable.get(table) ?? new Set(["rowid"]));
      for (const line of body.split("\n")) {
        const col = /^\s*(\w+)\s+[^,]*\b(PRIMARY KEY|UNIQUE)\b/i.exec(line);
        if (col) add(table, col[1]);
      }
    }
    for (const m of sql.matchAll(/CREATE UNIQUE INDEX(?:\s+IF NOT EXISTS)?\s+\w+\s*(?:\n\s*)?ON\s+(\w+)\s*\(([^)]*)\)([^;]*);/gi)) {
      const [, table, cols, tail] = m;
      if (/\bWHERE\b/i.test(tail)) continue;
      const parts = cols.split(",").map((c) => c.trim());
      if (parts.length === 1) add(table, parts[0]);
    }
  }
  return byTable;
}

interface OrderedQuery {
  where: string;
  table: string;
  /** The ordering columns, alias and direction stripped. */
  columns: string[];
  sql: string;
}

/** Every `ORDER BY` a `functions/` file sends, with the table it reads and the columns it orders by. */
function orderedQueries(): OrderedQuery[] {
  const found: OrderedQuery[] = [];
  for (const file of filesUnder(resolve(ROOT, "functions"), ".ts")) {
    const src = code(readFileSync(file, "utf8"));
    // A SQL string is a template or a plain double-quoted literal; both are matched for `ORDER BY`
    // and read up to the statement's end, a `LIMIT`, or the literal's closing quote.
    for (const m of src.matchAll(/(["`])((?:(?!\1)[\s\S])*?\bORDER BY\b(?:(?!\1)[\s\S])*?)\1/g)) {
      const sql = m[2];
      const order = /\bORDER BY\b([\s\S]*?)(?:\bLIMIT\b|$)/i.exec(sql);
      const from = /\bFROM\s+(\w+)/i.exec(sql);
      if (!order || !from) continue;
      const columns = order[1]
        .split(",")
        .map((t) => t.trim().replace(/\s+(ASC|DESC)$/i, "").replace(/^\w+\./, ""))
        .filter(Boolean);
      found.push({ where: relative(ROOT, file), table: from[1], columns, sql });
    }
  }
  return found;
}

describe("every ORDER BY a route sends to D1 is a total order", () => {
  const unique = uniqueColumnsByTable();
  const queries = orderedQueries();

  it("finds the ordered queries at all, so a green sweep is not an empty one", () => {
    expect(unique.get("raw_objects")).toContain("r2_key");
    expect(unique.get("phi_access_events")).toContain("id");
    // A composite primary key contributes none of its columns on its own.
    expect([...(unique.get("vault_envelopes") ?? [])]).toEqual(["rowid"]);
    expect(queries.length).toBeGreaterThanOrEqual(4);
  });

  it.each(orderedQueries().map((q) => [`${q.where} — ORDER BY ${q.columns.join(", ")} FROM ${q.table}`, q] as const))(
    "%s",
    (_label, q) => {
      const totalising = unique.get(q.table);
      // A table nothing in the migrations declares is a typo or a new table with no key: say which.
      expect(totalising, `no unique column known for table ${q.table}`).toBeTruthy();
      const tie = q.columns.filter((c) => totalising?.has(c));
      expect(
        tie.length,
        `${q.where} orders by ${q.columns.join(", ")}, none of which is unique in ${q.table} ` +
          `(${[...(totalising ?? [])].join(", ")}). Ties would be broken by the query plan — add rowid.`,
      ).toBeGreaterThan(0);
    },
  );
});

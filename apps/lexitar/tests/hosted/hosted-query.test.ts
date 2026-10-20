// Do the statements this app sends still RUN on HOSTED D1? Nothing in `npm test` can answer that.
//
// The suite's "real D1" is workerd's (tests/support/miniflare.ts) or Node's own SQLite
// (server/sqlite-d1.ts), and both carry SQLite's stock limits. Cloudflare's does not: it sets
// SQLITE_LIMIT_LIKE_PATTERN_LENGTH to 50 bytes against SQLite's 50,000-byte default and answers a
// longer pattern with `LIKE or GLOB pattern too complex: SQLITE_ERROR` — a message naming no length,
// so it reads as a malformed pattern rather than a long one. On 2026-10-20 that took every
// authorized `/api/raw/*` and `/api/chat-history/*` request on dev to a 500 for 1h14m, from a commit
// whose whole suite was green and stayed green: registering the fourth namespace prefix in
// raw-owner.ts's namespacePrefixes() crossed the limit by two bytes. The error pipeline filed it
// within four minutes of the deploy, which is the half of detection that worked. Nothing refused the
// deploy, because nothing in this repository had ever sent one of its own queries to the platform.
//
// This is that half, and it is a conformance suite rather than a smoke test: it calls the app's OWN
// query functions — not copies of their SQL, which is how the two would drift apart — against the
// hosted database this worktree's wrangler.jsonc names, with ids that match nothing. Three things
// make it a guard rather than a visit:
//
//   * It probes BOTH store prefixes, always. `prod/` is one byte longer than `dev/` throughout, so
//     a length defect that only prod would hit is caught from a dev branch, before the promote. The
//     one database answers both; the lengths under test belong to the KEY, not to the environment.
//   * It probes the worst client id the product allows, not a typical one. A client id is a name the
//     patient chose, so its length was never ours to bound, and it may contain `%` or `_` — literals
//     in a comparison and wildcards in a pattern, which is the second reason key-range.ts exists.
//   * It re-measures the LIKE limit and holds D1_LIKE_PATTERN_LIMIT to it. A narrowing fails: the
//     recorded figure would then be wrong in the dangerous direction. A widening passes with a note.
//
// READ-ONLY by construction: the adapter below refuses any statement that is not a SELECT, so this
// cannot write to or delete from a live database however it is called or however the app's functions
// change. Every probe asserts ZERO rows — which is both the proof the ids are synthetic and the
// reason no row, and so no PHI and no account id, is ever in reach of a failure message. A count is
// reported; a key, a name or an account id never is.
//
//   npm run test:hosted        # the database this worktree's branch owns
import { describe, it, expect } from "vitest";
import { d1, q, D1 } from "../../scripts/d1-remote";
import { wranglerTarget } from "../../scripts/target";
import type { D1Database, D1PreparedStatement } from "../../functions/_lib/identity-types";
import { D1_LIKE_PATTERN_LIMIT } from "../../functions/_lib/key-range";
import { ownerOfClientNamespace } from "../../functions/_lib/raw-owner";
import { listRawPdfsUnder, listRawObjectsUnder, listRawObjectsForAccount, listRecentAccessEventsForSubject } from "../../functions/_lib/identity-audit";
import { storeKey } from "../../functions/_lib/store";

/** A bound value as a SQL literal. Synthetic ids only — nothing here comes from a request. */
const lit = (v: unknown): string => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : q(String(v)));

/**
 * `?1`-numbered and bare-`?` placeholders inlined, `wrangler d1 execute --command` taking SQL and no
 * parameters. What is under test is a property of the pattern's VALUE, which is the same either way.
 * No statement reached from here holds a `?` inside a string literal; one that did would need a real
 * binder, and the SELECT-only check below is what keeps that from mattering silently.
 */
function inline(sql: string, binds: unknown[]): string {
  let next = 0;
  return sql.replace(/\?(\d*)/g, (_m: string, n: string) => lit(n ? binds[Number(n) - 1] : binds[next++]));
}

/** The app's D1 surface over `wrangler d1 execute --remote`, SELECT-only. */
function readOnlyRemoteD1(): D1Database {
  const prepare = (query: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const rows = async <T>(): Promise<T[]> => {
      const sql = inline(query, binds);
      if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`refused: this suite is read-only and that is not a SELECT — ${sql.slice(0, 60)}`);
      return d1<T>(sql);
    };
    const stmt = {
      bind(...values: unknown[]) {
        binds = values;
        return stmt;
      },
      async first<T>() {
        return (await rows<T>())[0] ?? null;
      },
      async all<T>() {
        return { results: await rows<T>() };
      },
      async run() {
        throw new Error("refused: this suite is read-only and run() writes");
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return { prepare, batch: () => Promise.reject(new Error("refused: this suite is read-only and batch() writes")) } as unknown as D1Database;
}

const db = readOnlyRemoteD1();

// A uuid is what the product actually issues; the other two are the shapes it cannot refuse. The
// 64-character name is the length a key prefix has no ceiling for, and the wildcard one is a name
// that is a LIKE pattern — both of which a range answers and a pattern does not.
const CLIENT_IDS: Array<[string, string]> = [
  ["a uuid", "834bc60d-0000-4000-8000-000000000000"],
  ["a 64-character name", "q".repeat(64)],
  ["a name of nothing but LIKE wildcards", "%_%_%_%_%_%_%_%_"],
];
const STORE_PREFIXES = ["dev", "prod"];
const NOBODY = "00000000-0000-4000-8000-000000000000";

/** Is a `LIKE` pattern of exactly `bytes` bytes accepted at all? The row count is irrelevant and unread. */
async function likeAccepted(bytes: number): Promise<boolean> {
  try {
    await d1(`SELECT 1 AS ok FROM raw_objects WHERE r2_key LIKE ${q("z".repeat(bytes - 1) + "%")} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

/** The platform's limit now, bisected between a length it accepts and one it refuses. */
async function measureLikeLimit(): Promise<number> {
  let lo = 1;
  let hi = 2;
  while (hi <= 1 << 17) {
    if (!(await likeAccepted(hi))) break;
    lo = hi;
    hi *= 2;
  }
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await likeAccepted(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const target = wranglerTarget();

describe(`every statement a route sends is accepted by hosted D1 (${D1} / ${target.database}, resolved from ${target.source})`, () => {
  it("reaches the hosted database at all, so a green run is not an empty one", async () => {
    const [row] = await d1<{ n: number }>("SELECT count(*) AS n FROM raw_objects");
    expect(typeof row.n, "the hosted database did not answer a trivial count — this run proved nothing").toBe("number");
  });

  for (const [idLabel, clientId] of CLIENT_IDS) {
    for (const prefix of STORE_PREFIXES) {
      const env = { STORE_PREFIX: prefix };
      const where = `${prefix}/…, ${idLabel}`;

      // The query the outage was in: four namespaces in one statement, the longest of them the
      // `regen-log/` prefix that crossed the limit.
      it(`ownerOfClientNamespace — ${where}`, async () => {
        expect(await ownerOfClientNamespace(db, env, clientId), "a synthetic client id resolved to an owner — this probe proves nothing").toBeNull();
      });

      it(`listRawPdfsUnder — ${where}`, async () => {
        const rows = await listRawPdfsUnder(db, `${storeKey(env, "raw", clientId)}/`);
        expect(rows.length, "a synthetic namespace matched real rows — this probe proves nothing").toBe(0);
      });

      it(`listRawObjectsUnder — ${where}`, async () => {
        const keys = await listRawObjectsUnder(db, `${storeKey(env, "raw", clientId)}/`);
        expect(keys.length, "a synthetic namespace matched real rows — this probe proves nothing").toBe(0);
      });
    }
  }

  // Keyed by account rather than by key prefix, so neither carries a length risk. They are here
  // because this suite's subject is the statements a route sends, and a refusal is a refusal whatever
  // its cause — a column renamed by a migration that only ran locally reads the same from here.
  it("listRawObjectsForAccount — an account that does not exist", async () => {
    expect((await listRawObjectsForAccount(db, NOBODY)).length, "a synthetic account owns rows — this probe proves nothing").toBe(0);
  });

  it("listRecentAccessEventsForSubject — a subject that does not exist", async () => {
    expect((await listRecentAccessEventsForSubject(db, NOBODY, 5)).length, "a synthetic subject has disclosure rows — this probe proves nothing").toBe(0);
  });

  it(`still caps a LIKE pattern at the ${D1_LIKE_PATTERN_LIMIT} bytes functions/_lib/key-range.ts records`, async () => {
    // Two calls in the ordinary case, and the bisection only when the boundary has moved.
    if ((await likeAccepted(D1_LIKE_PATTERN_LIMIT)) && !(await likeAccepted(D1_LIKE_PATTERN_LIMIT + 1))) return;
    const measured = await measureLikeLimit();
    expect(
      measured,
      `hosted D1 now refuses a LIKE pattern at ${measured} bytes, below the ${D1_LIKE_PATTERN_LIMIT} recorded in ` +
        `functions/_lib/key-range.ts. Update D1_LIKE_PATTERN_LIMIT and re-check every literal pattern against it — ` +
        `a prefix match already goes through a range and has no ceiling, but a suffix match like listRawPdfsUnder's ` +
        `'%.pdf' is a pattern and does.`,
    ).toBeGreaterThanOrEqual(D1_LIKE_PATTERN_LIMIT);
    console.log(
      `note: hosted D1 accepts a LIKE pattern of ${measured} bytes, above the ${D1_LIKE_PATTERN_LIMIT} recorded — ` +
        `a widening, so nothing here is at risk and the recorded figure is now conservative.`,
    );
  });
});

import { describe, it, expect, afterAll } from "vitest";
import type { D1Database } from "../../functions/_lib/identity-types";
import { SqliteD1Database } from "../../server/sqlite-d1";
import { useWorkerd } from "../support/miniflare";

// One contract, two backends: real workerd D1 (production) and SqliteD1Database (the Node host). The
// cases are the D1 behaviours the routes and vault's D1 stores lean on — not SQLite features in general.

const SCHEMA = "CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, n INTEGER, flag INTEGER, blob BLOB, note TEXT)";

function runD1Conformance(label: string, database: () => D1Database) {
  describe(`D1Database conformance (${label})`, () => {
    const db = () => database();

    it("first() is null on no rows, and a plain row object otherwise", async () => {
      await db().prepare(SCHEMA).run();
      expect(await db().prepare("SELECT * FROM t WHERE id = ?").bind("none").first()).toBeNull();
      await db().prepare("INSERT INTO t (id, n, note) VALUES (?, ?, ?)").bind("r1", 7, null).run();
      expect({ ...(await db().prepare("SELECT id, n, note FROM t WHERE id = ?").bind("r1").first<object>()) }).toEqual({ id: "r1", n: 7, note: null });
    });

    it("all() wraps rows in { results }", async () => {
      await db().prepare(SCHEMA).run();
      await db().prepare("INSERT INTO t (id, n) VALUES (?, ?)").bind("a1", 1).run();
      await db().prepare("INSERT INTO t (id, n) VALUES (?, ?)").bind("a2", 2).run();
      const { results } = await db().prepare("SELECT id FROM t WHERE id LIKE 'a%' ORDER BY id").all<{ id: string }>();
      expect(results.map((r) => r.id)).toEqual(["a1", "a2"]);
    });

    it("binds a boolean as 0/1 and round-trips a BLOB in a shape vault's D1 stores decode", async () => {
      await db().prepare(SCHEMA).run();
      await db().prepare("INSERT INTO t (id, flag, blob) VALUES (?, ?, ?)").bind("b1", true, new Uint8Array([9, 8, 7])).run();
      const row = await db().prepare("SELECT flag, blob FROM t WHERE id = ?").bind("b1").first<{ flag: number; blob: unknown }>();
      expect(row?.flag).toBe(1);
      // vault's adapters/d1 toBytes: a Uint8Array as-is, anything else through new Uint8Array().
      const blob = row?.blob instanceof Uint8Array ? row.blob : new Uint8Array(row?.blob as ArrayBuffer);
      expect([...blob]).toEqual([9, 8, 7]);
    });

    it("rejects an undefined bind rather than storing NULL", async () => {
      await db().prepare(SCHEMA).run();
      await expect(
        (async () => db().prepare("INSERT INTO t (id, note) VALUES (?, ?)").bind("u1", undefined).run())(),
      ).rejects.toThrow(/undefined/);
    });

    it("batch is all-or-nothing: a failing statement rolls back the ones before it", async () => {
      await db().prepare(SCHEMA).run();
      await db().prepare("INSERT INTO t (id) VALUES (?)").bind("dup").run();
      await expect(
        db().batch([
          db().prepare("INSERT INTO t (id) VALUES (?)").bind("x1"),
          db().prepare("INSERT INTO t (id) VALUES (?)").bind("dup"),
        ]),
      ).rejects.toThrow();
      expect(await db().prepare("SELECT id FROM t WHERE id = ?").bind("x1").first()).toBeNull();
    });

    it("batch applies every statement and returns row results for reads", async () => {
      await db().prepare(SCHEMA).run();
      const out = (await db().batch([
        db().prepare("INSERT INTO t (id, n) VALUES (?, ?)").bind("y1", 5),
        db().prepare("SELECT n FROM t WHERE id = ?").bind("y1"),
      ])) as { results: { n: number }[] }[];
      expect(out).toHaveLength(2);
      expect(out[1].results[0].n).toBe(5);
    });
  });
}

const w = useWorkerd({ workerdOnly: true });
runD1Conformance("workerd D1", () => w.db);

const sqlite = new SqliteD1Database(":memory:");
afterAll(() => sqlite.close());
runD1Conformance("SqliteD1Database", () => sqlite);

// A prefix match on an R2 key is a RANGE, and this file is why.
//
// D1 caps a LIKE pattern at 50 bytes. `{store}/regen-log/{uuid}/%` is 52, so the moment the fourth
// namespace was registered in raw-owner.ts, every authorized `/api/raw/*` and `/api/chat-history/*`
// request answered 500 with `D1_ERROR: LIKE or GLOB pattern too complex` — filed automatically as
// plover-factory#71 and #72 from the deployment of 8d23841.
//
// NOTHING IN THE SUITE COULD HAVE CAUGHT IT, AND THAT IS WHAT THE DRIFT GUARD BELOW IS FOR. The real
// database the route tests use is node's SQLite (tests/support/miniflare.ts), whose own pattern limit
// is SQLite's 50,000-byte default — a thousandfold higher — so the query that cannot run in production
// runs there without complaint, with the right answer. No fixture reproduces a hosted limit. What can
// be held locally is the SHAPE: no prefix match goes through LIKE at all, which is a property of the
// source and so is checked against the source.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { keyRange, prefixMatch, D1_LIKE_PATTERN_LIMIT } from "../../functions/_lib/key-range";
import { namespacePrefixes } from "../../functions/_lib/raw-owner";

const ROOT = resolve(__dirname, "../..");



/**
 * A source file with its comments removed. The sweeps below are about what is sent to D1, and this
 * file's own prose quotes the very form it forbids — a guard that reads a comment as a query is a
 * guard that cannot be explained in the file it guards.
 */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("keyRange", () => {
  it("brackets every key under a directory prefix", () => {
    const { from, to } = keyRange("dev/raw/alex/");
    expect("dev/raw/alex/report.pdf" >= from && "dev/raw/alex/report.pdf" < to).toBe(true);
    expect("dev/raw/alex/" >= from && "dev/raw/alex/" < to).toBe(true);
  });

  it("excludes the sibling whose name extends this one", () => {
    const { from, to } = keyRange("dev/raw/alex/");
    // The bug a `LIKE 'dev/raw/alex%'` would have: `alexander` is a different patient's client.
    expect("dev/raw/alexander/report.pdf" >= from && "dev/raw/alexander/report.pdf" < to).toBe(false);
    expect("dev/text/alex/report.pdf" >= from && "dev/text/alex/report.pdf" < to).toBe(false);
  });

  it("advances the final character and nothing else", () => {
    expect(keyRange("dev/raw/alex/")).toEqual({ from: "dev/raw/alex/", to: "dev/raw/alex0" });
  });

  it("treats `%` and `_` in a client id as the literals they are", () => {
    const { from, to } = keyRange("dev/raw/a_b%c/");
    expect("dev/raw/a_b%c/x.pdf" >= from && "dev/raw/a_b%c/x.pdf" < to).toBe(true);
    // A LIKE pattern would have matched these two; a comparison does not.
    expect("dev/raw/aXbYc/x.pdf" >= from && "dev/raw/aXbYc/x.pdf" < to).toBe(false);
    expect("dev/raw/a_bQQc/x.pdf" >= from && "dev/raw/a_bQQc/x.pdf" < to).toBe(false);
  });

  it("has no length ceiling — which is the entire point", () => {
    const long = `prod/regen-log/${"c".repeat(400)}/`;
    expect(long.length).toBeGreaterThan(D1_LIKE_PATTERN_LIMIT);
    const { from, to } = keyRange(long);
    expect(`${long}2026-10-20T00-00-00-000Z-0011aabb.enc` >= from).toBe(true);
    expect(`${long}2026-10-20T00-00-00-000Z-0011aabb.enc` < to).toBe(true);
  });

  it("refuses an empty prefix rather than quietly matching every key", () => {
    expect(() => keyRange("")).toThrow(/empty prefix/);
  });

  it("refuses a prefix it cannot derive an upper bound for", () => {
    // D1 compares TEXT as UTF-8 bytes, so advancing a non-ASCII final character is not the next string.
    expect(() => keyRange("dev/raw/é")).toThrow(/ASCII/);
  });
});

describe("prefixMatch", () => {
  it("numbers its two parameters from where the caller is", () => {
    const m = prefixMatch("r2_key", "dev/raw/alex/", 5);
    expect(m.sql).toBe("(r2_key >= ?5 AND r2_key < ?6)");
    expect(m.binds).toEqual(["dev/raw/alex/", "dev/raw/alex0"]);
  });
});

describe("the namespace a client occupies", () => {
  const env = { STORE_PREFIX: "prod" };
  const uuid = "834bc60d-c937-467d-9e78-3caa734acf45";

  it("still has a prefix that no LIKE pattern could have carried", () => {
    // The measurement that explains the outage, kept as an assertion so nobody re-derives it: this
    // is the prefix that crossed the limit, and it is the regen-log one.
    const over = namespacePrefixes(env, uuid).filter((p) => p.endsWith("/") && `${p}%`.length > D1_LIKE_PATTERN_LIMIT);
    expect(over).toEqual([`prod/regen-log/${uuid}/`]);
  });

  it("is bracketed by a range whatever the client id's length", () => {
    for (const prefix of namespacePrefixes(env, uuid)) {
      if (!prefix.endsWith("/")) continue;
      const { from, to } = keyRange(prefix);
      expect(`${prefix}x` >= from && `${prefix}x` < to).toBe(true);
    }
  });
});

describe("no prefix match in the hosted code reaches D1 as a LIKE", () => {
  const tsUnder = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === "node_modules" ? [] : tsUnder(p);
      return p.endsWith(".ts") ? [p] : [];
    });
  const files = tsUnder(resolve(ROOT, "functions"));

  it("finds the functions tree, so the sweeps below cannot pass by finding nothing", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(files.map((f) => [f.slice(ROOT.length + 1), f]))("%s binds no LIKE parameter", (_name, file) => {
    const src = code(readFileSync(file, "utf8"));
    // `LIKE ?` and `LIKE ?3` alike: a bound pattern is a pattern whose length the code does not know.
    expect(/LIKE\s*\?/.test(src)).toBe(false);
    // And nothing builds one by hand to bind positionally.
    expect(/\$\{[^}]*\}%`/.test(src)).toBe(false);
  });

  it.each(files.map((f) => [f.slice(ROOT.length + 1), f]))("%s keeps any literal LIKE pattern inside the limit", (_name, file) => {
    for (const [, pattern] of code(readFileSync(file, "utf8")).matchAll(/LIKE\s+'([^']*)'/g)) {
      expect(pattern.length, `${_name}: LIKE '${pattern}' is ${pattern.length} bytes`).toBeLessThanOrEqual(D1_LIKE_PATTERN_LIMIT);
    }
  });

  it("resolves a prefix through key-range.ts at every site that used to carry one", () => {
    for (const f of ["functions/_lib/raw-owner.ts", "functions/_lib/identity-audit.ts", "scripts/raw-cipher-cli.ts"]) {
      expect(readFileSync(resolve(ROOT, f), "utf8"), f).toMatch(/\b(keyRange|prefixMatch)\(/);
    }
  });
});

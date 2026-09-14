// W72 — the guard that makes the erasure route's promise checkable.
//
// An erasure that misses a class of object is the worst possible failure here, because the subject is
// TOLD their data is gone. A hand-written list of things to delete cannot catch that: it agrees with
// the implementation by construction, so it would keep passing forever after someone added a new key
// class. This derives the expectation from the OTHER side of the invariant — the real `storeKey()`
// call sites in `functions/` — exactly as `store-key-classes.test.ts` does for the backup tool, and
// for exactly the same reason. That test exists because a new class (`text/`) went unnoticed for five
// nights; this one exists so the same thing cannot make an erasure silently partial.
//
// Static source walk: no bundler, no runtime import.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `storeKey(env, "raw", …)` — a literal second argument is a DIRECTORY prefix under the store. */
const PREFIX_CALL = /\bstoreKey\(\s*[^,()]+,\s*"([a-z][a-z0-9-]*)"/g;
/** `storeKey(env, `chat-${id}.enc`)` — a template second argument is a FLAT key under the store. */
const TEMPLATE_CALL = /\bstoreKey\(\s*[^,()]+,\s*`([a-z][a-z0-9-]*)-\$\{/g;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFilesUnder(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

const dirPrefixes = new Map<string, string>();
const flatPrefixes = new Map<string, string>();
for (const file of tsFilesUnder(resolve(ROOT, "functions"))) {
  const src = readFileSync(file, "utf8");
  const where = file.slice(ROOT.length + 1);
  for (const m of src.matchAll(PREFIX_CALL)) if (!dirPrefixes.has(m[1])) dirPrefixes.set(m[1], where);
  for (const m of src.matchAll(TEMPLATE_CALL)) if (!flatPrefixes.has(m[1])) flatPrefixes.set(m[1], where);
}

const erasureSrc = readFileSync(resolve(ROOT, "functions/_lib/erasure.ts"), "utf8");

describe("every R2 key class the app writes is one erasure has an answer for", () => {
  it("finds the storeKey call sites at all, so an empty sweep cannot pass silently", () => {
    expect([...dirPrefixes.keys()].sort()).toEqual(expect.arrayContaining(["logs", "raw", "text"]));
    expect([...flatPrefixes.keys()].sort()).toEqual(expect.arrayContaining(["chat"]));
  });

  // Each directory class is either erased (its keys come from raw_objects) or explicitly excluded with
  // a reason. A new prefix belongs to neither list and fails here, at the commit that adds it.
  const ERASED_DIRS = ["raw", "text"];
  const EXCLUDED_DIRS: Record<string, string> = {
    // Request logs: route, status, latency, an id. Not the subject's content, and deleting them would
    // destroy the operational record of every OTHER request in the same window.
    logs: "operational request log, carries no record content",
  };

  it.each([...dirPrefixes].map(([p, where]) => [p, where]))("%s (written by %s) is erased or excluded with a reason", (prefix) => {
    const known = ERASED_DIRS.includes(prefix as string) || prefix in EXCLUDED_DIRS;
    expect(known, `R2 key class "${prefix}" is neither erased nor documented as excluded in erasure.ts`).toBe(true);
  });

  it("names the raw and text prefixes in the module that scans for unattributable objects", () => {
    // The scan is a literal list; this ties it to the derived set above so the two cannot drift.
    for (const prefix of ERASED_DIRS) expect(erasureSrc).toContain(`"${prefix}"`);
  });

  it("erases the flat per-vault classes — the vault blob and its chat history", () => {
    // `data-` is not written through a template (it is stored in vaults.r2Key), so it is asserted by
    // name; `chat-` is derived from the sweep above.
    expect([...flatPrefixes.keys()]).toContain("chat");
    expect(erasureSrc).toContain("chat-");
    expect(erasureSrc).toContain("data-");
  });
});

describe("every D1 table holding personal data is erased or excused", () => {
  // W73 correction to W72. The R2 half of this file derives its expectation from storeKey() call sites;
  // the D1 half did not exist at all, so a new table carrying account_id could be added and simply
  // never erased. W73 added two of them — exactly the case that would have slipped.
  //
  // Parsed from the migrations rather than listed here, for the same reason as the R2 sweep: a
  // hand-written list agrees with the implementation by construction and keeps passing forever.
  const sql = readdirSync(resolve(ROOT, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(resolve(ROOT, "migrations", f), "utf8"))
    .join("\n");

  /** CREATE TABLE …( … account_id … ) — a table keyed to a person is a table erasure must answer for. */
  const personalTables = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\)/g)]
    .filter(([, , body]) => /\baccount_id\b/.test(body))
    .map(([, name]) => name);

  const EXCUSED: Record<string, string> = {
    // Deliberately kept: it records who read WHOSE record, so deleting the subject's rows would destroy
    // a DIFFERENT patient's audit trail. Carries no record content — an id, an action, a timestamp.
    phi_access_events: "audit trail; deleting it would damage other patients' records",
  };

  it("finds the tables at all, so an empty sweep cannot pass silently", () => {
    expect(personalTables.length).toBeGreaterThanOrEqual(6);
    expect(personalTables).toContain("recovery_grants");
    expect(personalTables).toContain("raw_objects");
  });

  it.each(personalTables.map((t) => [t]))("%s is named by erasure.ts or excused", (table) => {
    const known = erasureSrc.includes(table as string) || (table as string) in EXCUSED;
    expect(known, `D1 table "${table}" carries account_id but erasure.ts never mentions it`).toBe(true);
  });
});

describe("the write path records ownership for everything erasure must find", () => {
  const recorders = tsFilesUnder(resolve(ROOT, "functions"))
    .filter((f) => readFileSync(f, "utf8").includes("recordRawObject("))
    .map((f) => f.slice(ROOT.length + 1))
    .filter((f) => !f.startsWith("functions/_lib/"));

  it("records on every route that writes a raw or text object", () => {
    // If a route writes into one of those namespaces and does NOT record ownership, its objects become
    // permanently unerasable the moment they are written — the pre-0008 problem, reintroduced.
    const writers = tsFilesUnder(resolve(ROOT, "functions"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return /VAULT\.put\(/.test(src) && /storeKey\([^,()]+,\s*"(raw|text)"/.test(src);
      })
      .map((f) => f.slice(ROOT.length + 1));
    expect(writers.length).toBeGreaterThan(0);
    expect(recorders.sort()).toEqual(expect.arrayContaining(writers.sort()));
  });
});

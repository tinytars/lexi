import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_TESTS } from "../../vitest.config";

// ── the partition itself ────────────────────────────────────────────────────────────────────────
//
// `npm test` (hosted) and `npm run test:data` (self-hosted) split the suite by INPUT. The split is
// only safe while it stays true, and it can rot two ways — a data test drifting out of the list, or a
// new test quietly reaching for records/private and breaking the hosted job. Both are cheap to hold.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A READ of records/private, not a mention of it. Comments discuss the path, and several tests build
// synthetic `records/private/...` strings they never open — matching those would make this guard cry
// wolf, which is the exact failure mode this milestone exists to remove.
//
// Known limitation: a path assembled indirectly slips through. The backstop is that the hosted job
// fails loudly on a missing file, so this catches the common case early rather than every case.
const PHI_READ =
  /(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|createReadStream)\s*\(\s*(?:resolve\s*\(\s*)?["'`]records\/private/;

describe("the hosted/local test partition", () => {
  it("every file named in DATA_TESTS actually exists", () => {
    for (const rel of DATA_TESTS) expect(existsSync(resolve(ROOT, rel)), rel).toBe(true);
  });

  // The load-bearing one. A test outside DATA_TESTS that reads records/private runs on ubuntu-latest,
  // where that directory does not exist — so it fails the hosted job for a reason that has nothing to
  // do with the change being gated. Catch it here, at the commit that adds it.
  it("no test outside DATA_TESTS reaches into records/private", () => {
    const dataSet = new Set(DATA_TESTS.map((p) => resolve(ROOT, p)));
    const offenders = readdirSync(resolve(ROOT, "tests/unit"))
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => resolve(ROOT, "tests/unit", f))
      .filter((f) => !dataSet.has(f) && PHI_READ.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it("finds the unit tests at all, so an empty sweep cannot pass silently", () => {
    expect(readdirSync(resolve(ROOT, "tests/unit")).filter((f) => f.endsWith(".test.ts")).length).toBeGreaterThan(150);
  });
});

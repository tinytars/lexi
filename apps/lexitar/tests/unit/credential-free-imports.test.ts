import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_TESTS } from "../../vitest.config";

// `npm test` runs without credentials; `npm run test:data` runs DATA_TESTS with them (CI job `lexitar-data`).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Matches a read of records/private, not a mention — tests build synthetic paths they never open.
const PHI_READ =
  /(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|createReadStream)\s*\(\s*(?:resolve\s*\(\s*)?["'`]records\/private/;

describe("the credential-free / data test partition", () => {
  it("every file named in DATA_TESTS actually exists", () => {
    for (const rel of DATA_TESTS) expect(existsSync(resolve(ROOT, rel)), rel).toBe(true);
  });

  // records/private does not exist in CI, so such a test would fail for an unrelated reason.
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

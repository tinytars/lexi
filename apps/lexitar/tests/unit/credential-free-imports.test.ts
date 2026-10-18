import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// THE UNIT SUITE NEEDS NO CREDENTIAL, AND THERE IS NO LONGER AN EXCEPTION TO CARVE OUT. This file
// used to police a partition: DATA_TESTS in vitest.config.ts named the one suite allowed to read the
// operator's credential store, and the rule below applied to every OTHER test. The one entry was
// tests/unit/vault-v2.test.ts, admitted on the premise that the org key was committed at
// records/org-key.json — which is the incident this tree is remediating, so the premise is gone and
// so is the partition. That test mints a throwaway key instead, and the rule here is now
// unconditional, which is strictly stronger than what it replaced.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Matches a read of records/private, not a mention — tests build synthetic paths they never open.
const PHI_READ =
  /(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|createReadStream)\s*\(\s*(?:resolve\s*\(\s*)?["'`]records\/private/;

const unitTests = () =>
  readdirSync(resolve(ROOT, "tests/unit"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => resolve(ROOT, "tests/unit", f));

describe("the unit suite is credential-free", () => {
  // records/private does not exist in CI, so such a test would fail for an unrelated reason — and
  // after Phase 4 of the remediation it does not exist in the repository at all.
  it("no unit test reaches into records/private", () => {
    const offenders = unitTests()
      .filter((f) => PHI_READ.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  // The one thing a fixture cannot assert is that the suite does not quietly re-acquire the
  // dependency it just shed, so assert it on the config instead: a carve-out re-added here is a
  // suite that passes on the operator's machine and fails on a stranger's clone.
  it("vitest.config.ts declares no credential-bound carve-out", async () => {
    const config = await import("../../vitest.config");
    expect(Object.keys(config)).toEqual(["default"]);
    // Comments are blanked rather than deleted, so the surviving offsets still compare and the
    // sweep judges code. The first version of this test did not, and failed against the comment
    // directly above the `exclude` line, which explains the carve-out this test exists to forbid —
    // i.e. it forbade the explanation of the rule along with the rule. Same defect, and the same
    // fix, as tests/unit/org-key-chokepoint.test.ts's own flush-ordering sweep.
    const code = readFileSync(resolve(ROOT, "vitest.config.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
    expect(code).not.toMatch(/DATA_TESTS/u);
  });

  it("finds the unit tests at all, so an empty sweep cannot pass silently", () => {
    expect(unitTests().length).toBeGreaterThan(150);
  });
});

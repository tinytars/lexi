import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOPILOT, DEPENDABOT, type Change, violations, testsToProve, redOnBase } from "../../scripts/autopilot-guard";

const change = (over: Partial<Change>): Change => ({
  author: AUTOPILOT,
  status: "M",
  path: "apps/lexitar/src/lib/x.ts",
  added: 1,
  removed: 1,
  addedLines: [],
  ...over,
});
const newTest = change({ status: "A", path: "apps/lexitar/tests/unit/x.test.ts", removed: 0, addedLines: ['it("x", () => {})'] });

describe("violations", () => {
  it("passes a source fix that ships its own test", () => {
    expect(violations([change({}), newTest])).toEqual([]);
  });

  it("forbids the agent from touching CI, deploy config, migrations and test config", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      "apps/lexitar/wrangler.jsonc",
      "apps/lexitar/migrations/0009_x.sql",
      "apps/lexitar/coverage-thresholds.json",
      "apps/lexitar/vitest.config.ts",
      "apps/lexitar/playwright.config.ts",
      "apps/lexitar/tests/setup.ts",
      "package-lock.json",
      "apps/lexitar/package.json",
    ]) {
      expect(violations([change({ path }), newTest]), path).toEqual([`${AUTOPILOT} may not touch ${path}`]);
    }
  });

  it("lets Dependabot touch manifests, the lockfile and workflow pins, and nothing else", () => {
    const ok = ["package-lock.json", "apps/lexitar/package.json", "package.json", ".github/workflows/ci.yml"];
    expect(violations(ok.map((path) => change({ author: DEPENDABOT, path })))).toEqual([]);
    expect(violations([change({ author: DEPENDABOT, path: "apps/lexitar/src/main.ts" })])).toEqual([
      `${DEPENDABOT} may not touch apps/lexitar/src/main.ts`,
    ]);
  });

  it("requires an agent fix to ship a test, unless it is repairing a Dependabot bump", () => {
    expect(violations([change({})])).toEqual([`${AUTOPILOT} fix adds no unit test`]);
    expect(violations([change({ author: DEPENDABOT, path: "package.json" }), change({})])).toEqual([]);
  });

  it("ignores commits by anyone else", () => {
    expect(violations([change({ author: "pablo-tech", path: ".github/workflows/ci.yml" })])).toEqual([]);
  });

  it("rejects a deleted test, a removed test line, and an added skip or only", () => {
    expect(violations([change({ status: "D", path: "apps/lexitar/tests/unit/y.test.ts" }), newTest])).toEqual([
      "apps/lexitar/tests/unit/y.test.ts: deletes a test file",
    ]);
    expect(violations([change({ path: "apps/lexitar/tests/unit/y.test.ts", removed: 2, addedLines: [] }), newTest])).toEqual([
      "apps/lexitar/tests/unit/y.test.ts: removes 2 existing test lines",
    ]);
    for (const line of ['it.skip("a", () => {})', 'describe.only("a", () => {})', 'test.todo("a")']) {
      expect(violations([change({ status: "A", path: "apps/lexitar/tests/e2e/z.spec.ts", removed: 0, addedLines: [line] }), newTest])).toEqual([
        `apps/lexitar/tests/e2e/z.spec.ts: adds ${line.trim()}`,
      ]);
    }
  });

  it("rejects an agent diff over the size cap, not counting the lockfile", () => {
    expect(violations([change({ added: 299, removed: 101 }), newTest])).toEqual(["agent diff is 401 lines (cap 400)"]);
    expect(violations([change({ author: DEPENDABOT, path: "package-lock.json", added: 5000 }), change({})])).toEqual([]);
  });
});

describe("testsToProve", () => {
  it("names the agent's new or changed unit tests, relative to the app", () => {
    expect(testsToProve([change({}), newTest, change({ author: DEPENDABOT, path: "package.json" })])).toEqual(["tests/unit/x.test.ts"]);
  });

  it("returns nothing on a pure Dependabot bump", () => {
    expect(testsToProve([change({ author: DEPENDABOT, path: "package.json" })])).toEqual([]);
  });
});

describe("redOnBase", () => {
  // A real two-commit repo: base has the bug, head fixes it and adds the test that proves it.
  const repo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
    const put = (p: string, s: string) => (mkdirSync(join(dir, p, ".."), { recursive: true }), writeFileSync(join(dir, p), s));
    git("init", "-q", "-b", "base");
    put("apps/lexitar/src/add.mjs", "export const add = (a, b) => a - b;\n");
    put("packages/frame/old.mjs", "export {};\n");
    git("add", "."), git("commit", "-qm", "base");
    git("rm", "-q", "packages/frame/old.mjs");
    put("apps/lexitar/src/add.mjs", "export const add = (a, b) => a + b;\n");
    put("apps/lexitar/tests/unit/add.test.mjs", 'import { add } from "../../src/add.mjs";\nif (add(1, 2) !== 3) process.exit(1);\n');
    put("apps/lexitar/tests/unit/vacuous.test.mjs", "process.exit(0);\n");
    git("add", "."), git("commit", "-qm", "fix");
    return dir;
  };
  const node = (files: string[]): [string, string[]] => ["node", files];

  it("is true when the new test fails against the base source", () => {
    const dir = repo();
    expect(redOnBase(dir, "HEAD~1", ["tests/unit/add.test.mjs"], node)).toBe(true);
    writeFileSync(join(dir, "untracked.txt"), "local work");
    expect(redOnBase(dir, "HEAD~1", ["tests/unit/add.test.mjs"], node)).toBe(true);
    expect(execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString()).toBe("?? untracked.txt\n");
  });

  it("is false for a test that passes without the fix", () => {
    expect(redOnBase(repo(), "HEAD~1", ["tests/unit/vacuous.test.mjs"], node)).toBe(false);
  });
});

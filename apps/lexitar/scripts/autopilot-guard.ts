import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { isMain } from "./is-main";

// Enforced in CI rather than in the agent's prompt: a prompt can be talked out of a rule, a check cannot.
export const AUTOPILOT = "plover-autopilot[bot]";
export const DEPENDABOT = "dependabot[bot]";
const APP = "apps/lexitar/";
const MAX_AGENT_LINES = 400;

export type Change = {
  author: string;
  status: "A" | "M" | "D" | "R";
  path: string;
  added: number;
  removed: number;
  addedLines: string[];
};

const MANIFEST = /(^|\/)package(-lock)?\.json$/;
const AGENT_FORBIDDEN = [
  /^\.github\//,
  MANIFEST,
  /^apps\/lexitar\/wrangler\.jsonc$/,
  /^apps\/lexitar\/migrations\//,
  /^apps\/lexitar\/coverage-thresholds\.json$/,
  /^apps\/lexitar\/(vitest|vitest\.data|playwright)\.config\.ts$/,
  /^apps\/lexitar\/tests\/setup\.ts$/,
];
const DEPENDABOT_ALLOWED = [MANIFEST, /^\.github\/workflows\/[^/]+\.ya?ml$/];
const TEST_FILE = /^apps\/lexitar\/tests\/.*\.(test|spec)\.[cm]?[jt]s$/;
const UNIT_TEST = /^apps\/lexitar\/tests\/unit\/.*\.test\.[cm]?[jt]s$/;
const WEAKENER = /\b(it|test|describe)\.(skip|only|todo)\b|\bx(it|describe)\(/;

export function violations(changes: Change[]): string[] {
  const agent = changes.filter((c) => c.author === AUTOPILOT);
  const bot = changes.filter((c) => c.author === DEPENDABOT);
  const out: string[] = [];
  for (const c of agent) if (AGENT_FORBIDDEN.some((re) => re.test(c.path))) out.push(`${AUTOPILOT} may not touch ${c.path}`);
  for (const c of bot) if (!DEPENDABOT_ALLOWED.some((re) => re.test(c.path))) out.push(`${DEPENDABOT} may not touch ${c.path}`);
  for (const c of agent.filter((c) => TEST_FILE.test(c.path))) {
    if (c.status === "D") out.push(`${c.path}: deletes a test file`);
    else if (c.status !== "A" && c.removed > 0) out.push(`${c.path}: removes ${c.removed} existing test lines`);
    for (const line of c.addedLines.filter((l) => WEAKENER.test(l))) out.push(`${c.path}: adds ${line.trim()}`);
  }
  const lines = agent.reduce((n, c) => n + c.added + c.removed, 0);
  if (lines > MAX_AGENT_LINES) out.push(`agent diff is ${lines} lines (cap ${MAX_AGENT_LINES})`);
  // A Dependabot repair is proven by CI going green on the bump; a bug fix must prove itself with a new failing test.
  if (agent.length && !bot.length && !testsToProve(changes).length) out.push(`${AUTOPILOT} fix adds no unit test`);
  return out;
}

export const testsToProve = (changes: Change[]): string[] => [
  ...new Set(changes.filter((c) => c.author === AUTOPILOT && c.status !== "D" && UNIT_TEST.test(c.path)).map((c) => c.path.slice(APP.length))),
];

// Rewinds the whole tree to `base` except for `tests`, runs them from the app, then restores HEAD.
// True iff they fail there. Removes only paths git tracks, so untracked local work survives.
export function redOnBase(repo: string, base: string, tests: string[], runner: (files: string[]) => [string, string[]]): boolean {
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const baseOnly = git("diff", "--name-only", "--no-renames", "--diff-filter=A", "HEAD", base).split("\n").filter(Boolean);
  git("restore", `--source=${base}`, "--worktree", "--", ".", ...tests.map((t) => `:!${APP}${t}`));
  try {
    const [cmd, args] = runner(tests);
    return spawnSync(cmd, args, { cwd: `${repo}/${APP}`, stdio: "inherit" }).status !== 0;
  } finally {
    git("restore", "--source=HEAD", "--worktree", "--", ".");
    for (const p of baseOnly) rmSync(`${repo}/${p}`, { force: true });
  }
}

function changesSince(repo: string, base: string): Change[] {
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  return git("log", "--no-merges", "--format=%H %an", `${base}..HEAD`)
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [sha, ...name] = line.split(" ");
      const author = name.join(" ");
      const statuses = new Map(
        git("diff-tree", "--no-commit-id", "-r", "--no-renames", "--name-status", sha)
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split("\t") as [Change["status"], string])
          .map(([s, p]) => [p, s]),
      );
      return git("diff-tree", "--no-commit-id", "-r", "--no-renames", "--numstat", sha)
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l): Change => {
          const [a, r, path] = l.split("\t");
          const addedLines = TEST_FILE.test(path)
            ? git("show", "--format=", "-U0", sha, "--", path).split("\n").filter((d) => d.startsWith("+") && !d.startsWith("+++")).map((d) => d.slice(1))
            : [];
          return { author, status: statuses.get(path) ?? "M", path, added: Number(a) || 0, removed: Number(r) || 0, addedLines };
        });
    });
}

if (isMain(import.meta.url)) {
  const [base] = process.argv.slice(2);
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const changes = changesSince(repo, base);
  const found = violations(changes);
  const tests = testsToProve(changes);
  const provesFix = changes.some((c) => c.author === DEPENDABOT) || !tests.length || redOnBase(repo, base, tests, (f) => ["npx", ["vitest", "run", ...f]]);
  if (!provesFix) found.push(`new tests pass without the fix, so they do not prove it: ${tests.join(", ")}`);
  if (found.length) {
    console.error(`autopilot-guard:\n${found.join("\n")}`);
    process.exit(1);
  }
  console.log(`autopilot-guard: ${changes.length} file changes checked, ok`);
}

import { execFileSync } from "node:child_process";
import { isMain } from "./is-main";

// Promotion is automatic only once dev has run quietly: no plover-factory error report may name a build
// from the commits being promoted. Reports carry `Build: tinytars/lexi@<sha>` (functions/_lib/github-issue.ts).
const SOAK_HOURS = 24;
const HOUR = 3_600_000;
const BUILD = /tinytars\/lexi@([0-9a-f]{7,40})/g;

export type Soak = { range: string[]; tipTime: number; now: number; ciGreen: boolean; reports: string[] };

export function promotionBlockers({ range, tipTime, now, ciGreen, reports }: Soak): string[] {
  if (!range.length) return ["dev has nothing that main lacks"];
  const out: string[] = [];
  const age = Math.floor((now - tipTime) / HOUR);
  if (age < SOAK_HOURS) out.push(`dev tip is ${age}h old; soak is ${SOAK_HOURS}h`);
  if (!ciGreen) out.push("CI is not green on the dev tip");
  const builds = new Set(reports.flatMap((r) => [...r.matchAll(BUILD)].map((m) => m[1])));
  for (const b of builds) if (range.some((sha) => sha.startsWith(b) || b.startsWith(sha))) out.push(`error reported from build ${b}, which is in the range`);
  return out;
}

if (isMain(import.meta.url)) {
  const [factory, main, dev] = process.argv.slice(2);
  const run = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26 }).trim();
  const range = run("git", "rev-list", `${main}..${dev}`).split("\n").filter(Boolean);
  const tip = range[0] ?? "";
  const since = range.length ? run("git", "show", "-s", "--format=%cI", range[range.length - 1]) : new Date().toISOString();
  const ci = tip ? run("gh", "api", `repos/tinytars/lexi/commits/${tip}/check-runs?per_page=100`, "-q", "[.check_runs[].conclusion]") : "[]";
  const conclusions: (string | null)[] = JSON.parse(ci);
  const bodies = (path: string): string[] =>
    (JSON.parse(run("gh", "api", "--paginate", "--slurp", `${path}&since=${since}`)) as { body: string | null }[][]).flat().map((i) => i.body ?? "");
  const blockers = promotionBlockers({
    range,
    tipTime: tip ? Date.parse(run("git", "show", "-s", "--format=%cI", tip)) : 0,
    now: Date.now(),
    ciGreen: conclusions.length > 0 && conclusions.every((c) => c === "success" || c === "skipped" || c === "neutral"),
    reports: [...bodies(`repos/${factory}/issues?state=all&labels=client-error&per_page=100`), ...bodies(`repos/${factory}/issues/comments?per_page=100`)],
  });
  if (blockers.length) {
    console.log(`not promoting:\n${blockers.join("\n")}`);
    process.exit(1);
  }
  console.log(`promoting ${range.length} commits`);
}

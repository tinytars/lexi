// Does this tree's wrangler.jsonc name the environment its branch owns? Run in CI, per push and per
// pull request, against `github.base_ref || github.ref_name` — see .github/workflows/ci.yml.
//
// It is a script rather than a unit test because the answer needs the BRANCH, and a unit test cannot
// see one: it runs in a worktree that is whatever branch somebody left it on, and on a pull request
// the branch that matters is the base, which is not even checked out. The classification itself is
// shared with the live-store refusals (scripts/target.ts) rather than copied here, so there is one
// definition of what makes a name a prod name.
//
//   npx tsx scripts/wrangler-branch-check.ts dev
import { wranglerTarget, branchMismatch, envOfBranch } from "./target";
import { isMain } from "./is-main";

function main(): void {
  const branch = (process.argv[2] ?? "").trim();
  if (!branch) throw new Error("usage: wrangler-branch-check.ts <branch>");

  const want = envOfBranch(branch);
  if (!want) {
    // A topic branch deploys nothing, so there is no environment it could contradict. Said out loud
    // rather than passed silently: a check that reports nothing is one nobody can tell is running.
    process.stdout.write(`wrangler-branch-check: '${branch}' is not a deploy branch — nothing to check.\n`);
    return;
  }

  const t = wranglerTarget();
  const m = branchMismatch(branch, t);
  if (m) throw new Error(m);
  process.stdout.write(
    `wrangler-branch-check: ${branch} owns ${want}, and wrangler.jsonc agrees — ` +
      `bucket=${t.bucket} db=${t.database} store=${t.storePrefix}\n`,
  );
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`\n${(e as Error).message}\n`);
    process.exit(1);
  }
}

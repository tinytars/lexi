// scripts/target.ts answers "which environment does this command act on" from the worktree's
// wrangler.jsonc, with three env vars overriding it for the deliberate cross-target run. What is
// tested here is the refusal that run needs: a target assembled from one store's bucket and another
// store's rows resolves fine, succeeds at every call it makes, and is wrong in a way no downstream
// error reports. Measured once already — a main checkout with STORE_PREFIX=dev answered
// `BACKUP ALARM — newest snapshot is 410.3h old` for a store whose backup was current.
import { describe, it, expect } from "vitest";
import { envOf, envOfBranch, envOfBaseUrl, targetMismatch, branchMismatch, baseUrlMismatch } from "../../scripts/target";

describe("the target's three halves", () => {
  // The hazard is not a race but a typo. A cross-target run overrides VAULT_BUCKET, D1_DATABASE and
  // STORE_PREFIX together; forget one and the command subtracts one store's claimed keys from the
  // other store's listing, which reports the whole store as abandoned and reads as a real finding.
  const dev = { bucket: "health-vault", database: "health-identity-dev", storePrefix: "dev" };
  const prod = { bucket: "health-vault-prod", database: "health-identity-prod", storePrefix: "prod" };

  it("accepts either store's own wrangler.jsonc values", () => {
    expect(targetMismatch(dev)).toBeNull();
    expect(targetMismatch(prod)).toBeNull();
  });

  it("refuses prod's bucket against dev's rows — the override with STORE_PREFIX and D1_DATABASE forgotten", () => {
    const m = targetMismatch({ ...dev, bucket: "health-vault-prod" });
    expect(m).toMatch(/halves disagree/);
    expect(m).toMatch(/bucket names prod/);
    expect(m).toMatch(/one store's objects would be read against the other/);
  });

  it("refuses each single-field slip, so no one of the three can be the forgotten one", () => {
    expect(targetMismatch({ ...prod, bucket: "health-vault" })).not.toBeNull();
    expect(targetMismatch({ ...prod, database: "health-identity-dev" })).not.toBeNull();
    expect(targetMismatch({ ...prod, storePrefix: "dev" })).not.toBeNull();
  });

  it("reads a name it does not recognise as dev, which mismatches rather than passes", () => {
    expect(envOf("health-vault-staging")).toBe("dev");
    expect(targetMismatch({ ...prod, bucket: "health-vault-staging" })).not.toBeNull();
  });
});

// The fourth input, and the one the three above cannot supply. A whole-file swap leaves every field
// agreeing with every other field, so `targetMismatch` passes it; what is wrong is the branch the
// file sits on. Measured: #181 and #182 were cut from `main` because a Dependabot SECURITY update
// ignores `dependabot.yml`'s target-branch, retargeted onto `dev` by the autopilot host, and left
// unrebased — each proposing prod's bucket, prod's database and `prod` to `dev`, as a patch bump
// that merges on green with no model call.
describe("the branch the wrangler.jsonc sits on", () => {
  const dev = { bucket: "health-vault", database: "health-identity-dev", storePrefix: "dev" };
  const prod = { bucket: "health-vault-prod", database: "health-identity-prod", storePrefix: "prod" };

  it("accepts each deploy branch's own values", () => {
    expect(branchMismatch("dev", dev)).toBeNull();
    expect(branchMismatch("main", prod)).toBeNull();
  });

  it("refuses prod's whole file on dev, which targetMismatch passes because it is self-consistent", () => {
    expect(targetMismatch(prod)).toBeNull();
    const m = branchMismatch("dev", prod);
    expect(m).toMatch(/branch dev owns dev/);
    expect(m).toMatch(/bucket names prod, database names prod, store prefix names prod/);
    expect(m).toMatch(/point dev's deployment at prod's store/);
  });

  it("refuses dev's whole file on main, so a promotion that drops the kept-back file is caught too", () => {
    expect(branchMismatch("main", dev)).toMatch(/branch main owns prod/);
  });

  it("names only the fields that are wrong, so a half-swapped file reads as half-swapped", () => {
    const m = branchMismatch("dev", { ...dev, bucket: "health-vault-prod" });
    expect(m).toMatch(/bucket names prod\./);
    expect(m).not.toMatch(/database names/);
  });

  // A topic branch deploys nothing, so it owns no environment and cannot contradict one. Returning
  // null rather than a refusal is what lets the check run on every push without a branch allowlist.
  it("declares no environment for a branch that deploys nothing", () => {
    expect(envOfBranch("guard/branch-target")).toBeNull();
    expect(branchMismatch("guard/branch-target", prod)).toBeNull();
    expect(envOfBranch("main")).toBe("prod");
    expect(envOfBranch("dev")).toBe("dev");
  });
});

// The fifth input, and the only one that is nowhere in the tree. The four above are all read from
// the worktree — the file's fields, then the branch the file sits on — and `LEXITAR_BASE_URL` is
// neither: it is typed on the command line, it alone decides which deployment a script signs in to,
// and until this guard nothing compared it to anything. One variable stood between the dev worktree
// and a real person's record.
describe("the deployment the base URL aims at", () => {
  const dev = { bucket: "health-vault", database: "health-identity-dev", storePrefix: "dev" };
  const prod = { bucket: "health-vault-prod", database: "health-identity-prod", storePrefix: "prod" };

  it("accepts each deployment from the worktree that owns it", () => {
    expect(baseUrlMismatch("https://health-dash-aex.pages.dev", dev)).toBeNull();
    expect(baseUrlMismatch("https://literacy.tinytars.foundation", prod)).toBeNull();
  });

  it("refuses production from a dev worktree — the run that would read a real record", () => {
    const m = baseUrlMismatch("https://literacy.tinytars.foundation", dev);
    expect(m).toMatch(/aimed at prod from a worktree bound to dev/);
    expect(m).toMatch(/db=health-identity-dev/);
    expect(m).toMatch(/Stand in the worktree whose branch owns prod/);
  });

  it("refuses dev from a main worktree, so the guard is not one-directional", () => {
    expect(baseUrlMismatch("https://health-dash-aex.pages.dev", prod)).toMatch(
      /aimed at dev from a worktree bound to prod/,
    );
  });

  // `npm run dev:functions` is started from whichever worktree you stand in and binds that tree's
  // wrangler.jsonc, so the local server IS the worktree's environment and cannot disagree with it.
  it("accepts localhost from either worktree, because the local server is the worktree", () => {
    expect(envOfBaseUrl("http://localhost:8788")).toBe("either");
    expect(baseUrlMismatch("http://localhost:8788", dev)).toBeNull();
    expect(baseUrlMismatch("http://127.0.0.1:8788", prod)).toBeNull();
  });

  // A preview deployment prefixes the project with a branch or commit label, so the project is the
  // label before `pages.dev` and never the first one — which is what a startsWith would have read.
  it("reads the project out of a preview hostname rather than its first label", () => {
    expect(envOfBaseUrl("https://abc1234.health-dash-main.pages.dev")).toBe("prod");
    expect(envOfBaseUrl("https://abc1234.health-dash-dev.pages.dev")).toBe("dev");
    expect(baseUrlMismatch("https://abc1234.health-dash-main.pages.dev", dev)).not.toBeNull();
  });

  // Deliberately not a refusal. The incident this closes is a RECOGNISED production origin reached
  // from the wrong tree; an unknown host is neither deployment, so refusing it would break a tunnel
  // or a test harness while catching nothing. Disagreement needs both halves named.
  it("passes a host it does not recognise, including one that is not a URL at all", () => {
    expect(envOfBaseUrl("https://example.test")).toBeNull();
    expect(baseUrlMismatch("https://example.test", prod)).toBeNull();
    expect(envOfBaseUrl("not a url")).toBeNull();
    expect(baseUrlMismatch("not a url", dev)).toBeNull();
  });
});

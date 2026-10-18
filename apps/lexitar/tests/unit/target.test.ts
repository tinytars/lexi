// scripts/target.ts answers "which environment does this command act on" from the worktree's
// wrangler.jsonc, with three env vars overriding it for the deliberate cross-target run. What is
// tested here is the refusal that run needs: a target assembled from one store's bucket and another
// store's rows resolves fine, succeeds at every call it makes, and is wrong in a way no downstream
// error reports. Measured once already — a main checkout with STORE_PREFIX=dev answered
// `BACKUP ALARM — newest snapshot is 410.3h old` for a store whose backup was current.
import { describe, it, expect } from "vitest";
import { envOf, envOfBranch, targetMismatch, branchMismatch } from "../../scripts/target";

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

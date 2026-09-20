import { describe, it, expect } from "vitest";
import { deploymentVerdict, type Deployment } from "../../scripts/pages-deploy-status";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const deployment = (commit: string, status: string): Deployment => ({
  deployment_trigger: { metadata: { commit_hash: commit } },
  latest_stage: { name: "deploy", status },
});

describe("deploymentVerdict", () => {
  it("waits while Pages has not picked the commit up yet", () => {
    expect(deploymentVerdict([], SHA)).toBe("waiting");
    expect(deploymentVerdict([deployment("f".repeat(40), "success")], SHA)).toBe("waiting");
  });

  it("waits while this commit's build is still running", () => {
    expect(deploymentVerdict([deployment(SHA, "active")], SHA)).toBe("waiting");
  });

  it("fails a build that failed, which today only shows as a stale bundle still being served", () => {
    expect(deploymentVerdict([deployment(SHA, "failure")], SHA)).toBe("failed");
    expect(deploymentVerdict([deployment(SHA, "canceled")], SHA)).toBe("failed");
  });

  it("passes this commit's own success, not a newer deployment's", () => {
    expect(deploymentVerdict([deployment(SHA, "success")], SHA)).toBe("ok");
    expect(deploymentVerdict([deployment("a".repeat(40), "success"), deployment(SHA, "failure")], SHA)).toBe("failed");
  });
});

import { describe, it, expect } from "vitest";
import { missingPagesSecrets, tokenExpiry, pipelineBlockers, canaryFingerprint } from "../../scripts/error-pipeline-check";

const HOUR = 3_600_000;
const now = Date.parse("2026-09-20T12:00:00Z");
const required = ["CLIENT_ERROR_GITHUB_TOKEN", "CLIENT_ERROR_GITHUB_REPO"];
const set = (...names: string[]) => Object.fromEntries(names.map((n) => [n, { value: "x" }]));
const healthy = {
  now,
  canaryAt: now - HOUR,
  maxCanaryAgeH: 8,
  missingSecrets: [] as string[],
  tokenReaches: true,
  tokenDaysLeft: null as number | null,
};

describe("missingPagesSecrets", () => {
  it("passes a project that carries both secrets on the environment serving its branch", () => {
    const project = { deployment_configs: { production: { env_vars: set(...required) } } };
    expect(missingPagesSecrets(project, required)).toEqual([]);
  });

  // The failure this exists for: dev files nothing, and the promotion gate reads that silence as a
  // clean soak.
  it("catches a token unset on the environment the soak runs on", () => {
    const project = { deployment_configs: { production: { env_vars: set("CLIENT_ERROR_GITHUB_REPO") } } };
    expect(missingPagesSecrets(project, required)).toEqual(["production:CLIENT_ERROR_GITHUB_TOKEN"]);
  });

  // Pins the decision, not just the code: preview is per-PR and deliberately unconfigured, so
  // demanding the token there would fail this check forever against a correct deployment.
  it("does not demand the token on preview, where a crash is from code nobody promoted", () => {
    const project = { deployment_configs: { production: { env_vars: set(...required) }, preview: { env_vars: {} } } };
    expect(missingPagesSecrets(project, required)).toEqual([]);
    expect(missingPagesSecrets(project, required, ["production", "preview"])).toEqual([
      "preview:CLIENT_ERROR_GITHUB_TOKEN",
      "preview:CLIENT_ERROR_GITHUB_REPO",
    ]);
  });

  it("treats a project with no configuration at all as missing everything", () => {
    expect(missingPagesSecrets({}, required)).toEqual([
      "production:CLIENT_ERROR_GITHUB_TOKEN",
      "production:CLIENT_ERROR_GITHUB_REPO",
    ]);
  });
});

describe("tokenExpiry", () => {
  it("reads the header GitHub sends for a fine-grained token", () => {
    const { daysLeft } = tokenExpiry(new Headers({ "github-authentication-token-expiration": "2026-10-04 12:00:00 UTC" }), now);
    expect(daysLeft).toBe(14);
  });

  // The token in use today is a classic PAT, which sends no header at all. Reading that as "expired"
  // would have shipped this workflow red on day one, forever.
  it("answers cannot-tell rather than expired when the header is absent", () => {
    expect(tokenExpiry(new Headers(), now)).toEqual({ expiresAt: null, daysLeft: null });
  });
});

describe("pipelineBlockers", () => {
  it("clears a pipeline whose canary arrived within the window", () => {
    expect(pipelineBlockers(healthy)).toEqual([]);
  });

  it("blocks when a secret is missing anywhere", () => {
    expect(pipelineBlockers({ ...healthy, missingSecrets: ["preview:CLIENT_ERROR_GITHUB_TOKEN"] })).toEqual([
      "Pages is missing preview:CLIENT_ERROR_GITHUB_TOKEN",
    ]);
  });

  it("blocks when the token cannot reach the tracker, which is what an expiry would cause anyway", () => {
    expect(pipelineBlockers({ ...healthy, tokenReaches: false })).toEqual(["the GitHub token cannot reach the issue tracker"]);
  });

  it("blocks on a token about to expire, and not on one with room left", () => {
    expect(pipelineBlockers({ ...healthy, tokenDaysLeft: 13 })).toEqual(["the GitHub token expires in 13d"]);
    expect(pipelineBlockers({ ...healthy, tokenDaysLeft: 14 })).toEqual([]);
  });

  it("blocks on a canary that never arrived, and on one too old to mean anything", () => {
    expect(pipelineBlockers({ ...healthy, canaryAt: null })).toEqual(["no canary report has ever reached the tracker"]);
    expect(pipelineBlockers({ ...healthy, canaryAt: now - 9 * HOUR })).toEqual(["the last canary reached the tracker 9h ago, over the 8h limit"]);
  });
});

describe("canaryFingerprint", () => {
  // The gate and the canary look each other up by this label; if they ever computed it differently
  // the gate would block forever on a canary that is in fact arriving.
  it("is stable, so the canary issue is always found by label", async () => {
    expect(await canaryFingerprint()).toMatch(/^[0-9a-f]{8}$/);
    expect(await canaryFingerprint()).toBe(await canaryFingerprint());
  });
});

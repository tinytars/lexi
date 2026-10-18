import { isMain } from "./is-main";

// Pages deploys through the git integration, not through CI, so a failed build is invisible here:
// the branch keeps serving the previous bundle and the promotion gate still reads CI as green.
// This watches the deployment for one commit and fails the run if it never succeeds.

const POLL_MS = 20_000;
const TIMEOUT_MS = 10 * 60_000;

export interface Deployment {
  deployment_trigger?: { metadata?: { commit_hash?: string } };
  latest_stage?: { name?: string; status?: string };
}

export type Verdict = "ok" | "failed" | "waiting";

export function deploymentVerdict(deployments: Deployment[], sha: string): Verdict {
  const mine = deployments.find((d) => d.deployment_trigger?.metadata?.commit_hash === sha);
  if (!mine) return "waiting";
  const status = mine.latest_stage?.status;
  if (status === "success") return "ok";
  if (status === "failure" || status === "canceled" || status === "skipped") return "failed";
  return "waiting";
}

if (isMain(import.meta.url)) {
  const [project, sha] = process.argv.slice(2);
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${project}/deployments?per_page=25`;
  const headers = { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` };
  const deadline = Date.now() + TIMEOUT_MS;
  let verdict: Verdict = "waiting";
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Pages deployments query failed: ${res.status}`);
    verdict = deploymentVerdict(((await res.json()) as { result: Deployment[] }).result, sha);
    if (verdict !== "waiting") break;
    console.log(`waiting for ${project} to deploy ${sha.slice(0, 7)}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log(`${project} @ ${sha.slice(0, 7)}: ${verdict}`);
  if (verdict !== "ok") process.exit(1);
}

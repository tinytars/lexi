import { fingerprintOf, scrubMessage } from "../functions/_lib/client-error";
import { isMain } from "./is-main";

// The error pipeline is the only telemetry this product has, and it fails silently: a revoked token,
// an unset secret, or a Worker that stopped filing all read from the outside exactly like a quiet
// week. Everything here answers "is it still alive", so that scripts/promotion-gate.ts can refuse
// to read silence as health.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_TOKEN_DAYS = 14;
const CANARY_MESSAGE = "error pipeline canary";
const CANARY_POLL_MS = 5_000;
const CANARY_TIMEOUT_MS = 90_000;
const GITHUB = "https://api.github.com";

export interface PagesProject {
  subdomain?: string;
  deployment_configs?: {
    production?: { env_vars?: Record<string, unknown> | null };
    preview?: { env_vars?: Record<string, unknown> | null };
  };
}

/**
 * Where Cloudflare actually serves a project, which is NOT derivable from its name: health-dash-dev
 * is served at health-dash-aex.pages.dev. Guessing it makes the canary POST into a void and read as
 * a dead sink forever.
 */
export function canaryOrigin(project: PagesProject): string {
  if (!project.subdomain) throw new Error("Pages project reports no subdomain; cannot address the canary");
  return `https://${project.subdomain}`;
}

/**
 * Names of required variables absent from a deployment environment, as "<environment>:<name>".
 *
 * Only `production` is checked by default, which is a decision rather than an oversight. A Pages
 * project's production config serves its production branch — `dev` for health-dash-dev, `main` for
 * health-dash-main — so that is the environment the soak and real users run on. `preview` serves
 * ephemeral per-PR deployments, where the token is deliberately unset: a crash on an unmerged
 * branch filing into the inbox is noise from code nobody promoted.
 */
export function missingPagesSecrets(
  project: PagesProject,
  required: string[],
  environments: readonly ("production" | "preview")[] = ["production"],
): string[] {
  return environments.flatMap((environment) => {
    const vars = project.deployment_configs?.[environment]?.env_vars ?? {};
    return required.filter((name) => vars[name] == null).map((name) => `${environment}:${name}`);
  });
}

/**
 * Days until the token GitHub answered with expires. A CLASSIC PAT sends no expiry header, and the
 * token in use today is one — so `null` means "cannot tell", not "expired", and does not block. What
 * blocks is the token failing to reach the repo, which is the failure this is a proxy for anyway.
 */
export function tokenExpiry(headers: Headers, now: number = Date.now()): { expiresAt: number | null; daysLeft: number | null } {
  const raw = headers.get("github-authentication-token-expiration");
  const expiresAt = raw ? Date.parse(raw.replace(" UTC", "Z").replace(" ", "T")) : NaN;
  if (Number.isNaN(expiresAt)) return { expiresAt: null, daysLeft: null };
  return { expiresAt, daysLeft: Math.floor((expiresAt - now) / DAY_MS) };
}

export interface PipelineState {
  now: number;
  canaryAt: number | null;
  maxCanaryAgeH: number;
  missingSecrets: string[];
  tokenReaches: boolean;
  tokenDaysLeft: number | null;
}

export function pipelineBlockers({ now, canaryAt, maxCanaryAgeH, missingSecrets, tokenReaches, tokenDaysLeft }: PipelineState): string[] {
  const out: string[] = [];
  if (missingSecrets.length) out.push(`Pages is missing ${missingSecrets.join(", ")}`);
  if (!tokenReaches) out.push("the GitHub token cannot reach the issue tracker");
  if (tokenDaysLeft !== null && tokenDaysLeft < MIN_TOKEN_DAYS) out.push(`the GitHub token expires in ${tokenDaysLeft}d`);
  if (canaryAt === null) out.push("no canary report has ever reached the tracker");
  else if (now - canaryAt > maxCanaryAgeH * HOUR_MS)
    out.push(`the last canary reached the tracker ${Math.floor((now - canaryAt) / HOUR_MS)}h ago, over the ${maxCanaryAgeH}h limit`);
  return out;
}

/** The fingerprint the canary always files under, so its issue is found by label and never pinned by hand. */
export const canaryFingerprint = (): Promise<string> => fingerprintOf("Error", scrubMessage(CANARY_MESSAGE));

if (isMain(import.meta.url)) {
  const [devProject, factory] = process.argv.slice(2);
  const token = process.env.CLIENT_ERROR_GITHUB_TOKEN!;
  const gh = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "lexitar-error-pipeline" };

  const project = async (name: string): Promise<PagesProject> => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${name}`,
      { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } },
    );
    if (!res.ok) throw new Error(`Pages project ${name} query failed: ${res.status}`);
    return ((await res.json()) as { result: PagesProject }).result;
  };

  const projects = await Promise.all(
    [devProject, "health-dash-main"].map(async (name) => ({ name, project: await project(name) })),
  );
  const missingSecrets = projects.flatMap(({ name, project }) =>
    missingPagesSecrets(project, ["CLIENT_ERROR_GITHUB_TOKEN", "CLIENT_ERROR_GITHUB_REPO"]).map((m) => `${name}/${m}`),
  );
  const deployment = canaryOrigin(projects[0].project);

  const reach = await fetch(`${GITHUB}/repos/${factory}`, { headers: gh });
  const { daysLeft } = tokenExpiry(reach.headers);

  // The only check that exercises secrets + Worker + scrubbing + GitHub end to end, over the same
  // anonymous path a tab too stale to boot uses.
  const label = `fp:${await canaryFingerprint()}`;
  const updatedAt = async (): Promise<number | null> => {
    const res = await fetch(`${GITHUB}/repos/${factory}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`, { headers: gh });
    if (!res.ok) throw new Error(`canary issue lookup failed: ${res.status}`);
    const issue = ((await res.json()) as { updated_at: string }[])[0];
    return issue ? Date.parse(issue.updated_at) : null;
  };

  const before = await updatedAt();
  const posted = await fetch(`${deployment}/api/client-error`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: deployment },
    body: JSON.stringify({ name: "Error", message: CANARY_MESSAGE, stack: "", build: "" }),
  });
  console.log(`canary POST ${posted.status}`);

  let canaryAt: number | null = before;
  for (const deadline = Date.now() + CANARY_TIMEOUT_MS; Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, CANARY_POLL_MS));
    canaryAt = await updatedAt();
    if (canaryAt !== null && canaryAt !== before) break;
  }

  // The gate tolerates a canary up to CANARY_MAX_AGE_H old; this run does not tolerate its own
  // failing, or nobody learns the sink died until the gate blocks a promotion hours later.
  const blockers = pipelineBlockers({
    now: Date.now(),
    canaryAt,
    maxCanaryAgeH: Number(process.env.CANARY_MAX_AGE_H ?? 8),
    missingSecrets,
    tokenReaches: reach.ok,
    tokenDaysLeft: daysLeft,
  });
  if (canaryAt === before) blockers.push(`this run's canary did not reach ${factory} within ${CANARY_TIMEOUT_MS / 1000}s`);
  if (blockers.length) {
    console.log(`error pipeline is not proven alive:\n${blockers.map((b) => `- ${b}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`error pipeline is alive (canary at ${new Date(canaryAt!).toISOString()})`);
}

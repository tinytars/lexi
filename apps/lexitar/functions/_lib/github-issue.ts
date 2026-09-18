import type { ClientErrorReport } from "./client-error";

export interface GithubIssueEnv {
  CLIENT_ERROR_GITHUB_TOKEN?: string;
  CLIENT_ERROR_GITHUB_REPO?: string; // "owner/name"
}

const API = "https://api.github.com";

function headers(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "lexitar-client-error",
    "content-type": "application/json",
  };
}

// The title carries no message: scrubbing is a denylist, so the scrubbed text stays in the body only.
export function issueTitle(r: ClientErrorReport): string {
  return `Client error: ${r.name} [${r.fingerprint}]`;
}

function occurrence(r: ClientErrorReport, context: { deployment: string; userAgent: string }): string {
  const stack = r.frames.length ? r.frames.map((f) => `    at ${f}`).join("\n") : "    (no stack frames)";
  return [
    `**${r.name}:** ${r.message || "(no message)"}`,
    "",
    "```",
    stack,
    "```",
    "",
    `- Deployment: \`${context.deployment}\``,
    `- Build: ${r.build ? `tinytars/lexi@${r.build}` : "unknown"}`,
    `- User agent: \`${context.userAgent}\``,
    `- Seen: ${new Date().toISOString()}`,
    "",
    "_Filed automatically by LexiTar's browser error reporter (`functions/api/client-error.ts`). Message and stack are PHI-scrubbed._",
  ].join("\n");
}

// One open issue per fingerprint: a recurrence comments on it instead of opening a duplicate. The lookup
// is by label, not /search/issues: search lagged a new issue by over a minute, the label filter by ~4s,
// so only a repeat inside those few seconds can still open a duplicate.
export async function fileClientError(
  env: GithubIssueEnv,
  report: ClientErrorReport,
  context: { deployment: string; userAgent: string },
): Promise<"created" | "commented"> {
  const token = env.CLIENT_ERROR_GITHUB_TOKEN!;
  const repo = env.CLIENT_ERROR_GITHUB_REPO!;
  const body = occurrence(report, context);

  const label = `fp:${report.fingerprint}`;

  const lookup = await fetch(`${API}/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`, { headers: headers(token) });
  if (!lookup.ok) throw new Error(`GitHub issue lookup failed: ${lookup.status}`);
  const existing = ((await lookup.json()) as { number: number }[])[0];

  const res = existing
    ? await fetch(`${API}/repos/${repo}/issues/${existing.number}/comments`, { method: "POST", headers: headers(token), body: JSON.stringify({ body }) })
    : await fetch(`${API}/repos/${repo}/issues`, { method: "POST", headers: headers(token), body: JSON.stringify({ title: issueTitle(report), body, labels: ["client-error", label] }) });
  if (!res.ok) throw new Error(`GitHub issue ${existing ? "comment" : "create"} failed: ${res.status}`);
  return existing ? "commented" : "created";
}

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

export function issueTitle(r: ClientErrorReport): string {
  return `Client error: ${r.name}: ${r.message || "(no message)"} [${r.fingerprint}]`;
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
    `- User agent: \`${context.userAgent}\``,
    `- Seen: ${new Date().toISOString()}`,
    "",
    "_Filed automatically by LexiTar's browser error reporter (`functions/api/client-error.ts`). Message and stack are PHI-scrubbed._",
  ].join("\n");
}

// One open issue per fingerprint: a recurrence comments on it instead of opening a duplicate.
export async function fileClientError(
  env: GithubIssueEnv,
  report: ClientErrorReport,
  context: { deployment: string; userAgent: string },
): Promise<"created" | "commented"> {
  const token = env.CLIENT_ERROR_GITHUB_TOKEN!;
  const repo = env.CLIENT_ERROR_GITHUB_REPO!;
  const body = occurrence(report, context);

  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "[${report.fingerprint}]"`);
  const search = await fetch(`${API}/search/issues?q=${q}&per_page=1`, { headers: headers(token) });
  if (!search.ok) throw new Error(`GitHub issue search failed: ${search.status}`);
  const existing = ((await search.json()) as { items: { number: number }[] }).items[0];

  const res = existing
    ? await fetch(`${API}/repos/${repo}/issues/${existing.number}/comments`, { method: "POST", headers: headers(token), body: JSON.stringify({ body }) })
    : await fetch(`${API}/repos/${repo}/issues`, { method: "POST", headers: headers(token), body: JSON.stringify({ title: issueTitle(report), body }) });
  if (!res.ok) throw new Error(`GitHub issue ${existing ? "comment" : "create"} failed: ${res.status}`);
  return existing ? "commented" : "created";
}

import type { ClientErrorReport } from "./client-error";

export interface GithubIssueEnv {
  CLIENT_ERROR_GITHUB_TOKEN?: string;
  CLIENT_ERROR_GITHUB_REPO?: string; // "owner/name"
}

const API = "https://api.github.com";
const RETRY_MS = 500;

// Which failures a caller can do anything about. `auth` and `gone` mean the configuration is dead and
// a human has to act; retrying those only doubles the load on a token that is already being refused.
export type SinkFailure = "auth" | "gone" | "transient" | "unknown";

export class GithubSinkError extends Error {
  constructor(
    readonly status: number,
    readonly kind: SinkFailure,
    what: string,
  ) {
    super(`GitHub ${what} failed: ${status}`);
    this.name = "GithubSinkError";
  }
}

const kindOf = (status: number): SinkFailure =>
  status === 401 || status === 403 ? "auth" : status === 404 || status === 410 ? "gone" : status === 429 || status >= 500 ? "transient" : "unknown";

async function send(what: string, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const kind = kindOf(res.status);
    if (kind !== "transient" || attempt === 1) throw new GithubSinkError(res.status, kind, what);
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

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

export interface Report {
  title: string;
  body: string;
  fingerprint: string;
  labels: string[]; // the source label ("client-error", "server-error", …); fp: is added here
}

// One open issue per fingerprint: a recurrence comments on it instead of opening a duplicate. The lookup
// is by label, not /search/issues: search lagged a new issue by over a minute, the label filter by ~4s,
// so only a repeat inside those few seconds can still open a duplicate.
export async function fileReport(env: GithubIssueEnv, report: Report): Promise<"created" | "commented"> {
  const token = env.CLIENT_ERROR_GITHUB_TOKEN!;
  const repo = env.CLIENT_ERROR_GITHUB_REPO!;
  const label = `fp:${report.fingerprint}`;

  const lookup = await send("issue lookup", `${API}/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`, {
    headers: headers(token),
  });
  const existing = ((await lookup.json()) as { number: number; labels?: { name: string }[] }[])[0];

  // A crash first seen logged-out opens a `pre-auth` issue, and every authenticated recurrence after it
  // only comments — so without this the issue never gains `client-error`, never gates promotion, and
  // never reaches the autopilot. The lookup already returned the labels, so the extra call happens once
  // per issue, the first time a source that is missing shows up.
  if (existing) {
    const have = new Set((existing.labels ?? []).map((l) => l.name));
    const missing = report.labels.filter((l) => !have.has(l));
    if (missing.length)
      await send("issue label", `${API}/repos/${repo}/issues/${existing.number}/labels`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ labels: missing }),
      });
  }

  if (existing) {
    await send("issue comment", `${API}/repos/${repo}/issues/${existing.number}/comments`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ body: report.body }),
    });
    return "commented";
  }
  await send("issue create", `${API}/repos/${repo}/issues`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ title: report.title, body: report.body, labels: [...report.labels, label] }),
  });
  return "created";
}

export function fileClientError(
  env: GithubIssueEnv,
  report: ClientErrorReport,
  context: { deployment: string; userAgent: string },
  label: "client-error" | "pre-auth" = "client-error",
): Promise<"created" | "commented"> {
  return fileReport(env, {
    title: issueTitle(report),
    body: occurrence(report, context),
    fingerprint: report.fingerprint,
    labels: [label],
  });
}

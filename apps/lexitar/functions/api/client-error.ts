import { requireSession, type SessionEnv } from "../_lib/session";
import { toReport } from "../_lib/client-error";
import { fileClientError, type GithubIssueEnv } from "../_lib/github-issue";

// Sink for src/lib/error-reporter.ts: an uncaught browser error becomes a GitHub issue (or a comment on
// the open one with the same fingerprint). Session-gated so the public URL can't be used to spam the
// tracker; without CLIENT_ERROR_GITHUB_{TOKEN,REPO} it only reaches `wrangler pages deployment tail`.

type Env = SessionEnv & GithubIssueEnv;

const MAX_BODY = 16_384;

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;

  const text = await request.text();
  if (text.length > MAX_BODY) return new Response(null, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }

  const report = await toReport(body);
  const reportContext = { deployment: new URL(request.url).host, userAgent: (request.headers.get("user-agent") ?? "unknown").slice(0, 200) };
  if (!env.CLIENT_ERROR_GITHUB_TOKEN || !env.CLIENT_ERROR_GITHUB_REPO) {
    console.error("client-error (no GitHub sink configured)", JSON.stringify({ ...report, ...reportContext }));
    return new Response(null, { status: 204 });
  }
  try {
    await fileClientError(env, report, reportContext);
  } catch (e) {
    console.error("client-error: filing failed", (e as Error).message, JSON.stringify(report));
  }
  return new Response(null, { status: 204 });
}

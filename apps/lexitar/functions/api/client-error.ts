import { requireSession, type SessionEnv } from "../_lib/session";
import { toReport } from "../_lib/client-error";
import { fileClientError, type GithubIssueEnv } from "../_lib/github-issue";
import { spendReportBudget } from "../_lib/report-budget";
import { logRequest } from "../_lib/log";

// Sink for src/lib/error-reporter.ts and index.html's boot guard: an uncaught browser error becomes a
// GitHub issue (or a comment on the open one with the same fingerprint). Without
// CLIENT_ERROR_GITHUB_{TOKEN,REPO} it only reaches `wrangler pages deployment tail`.
//
// The session USED to gate this endpoint. It no longer does, because the crashes that matter most
// arrive without one: a bundle too stale to boot, and every failure on the lock, login, signup and
// recovery screens. A session now only classifies — `client-error` for a signed-in report,
// `pre-auth` for an anonymous one, which gates no promotion and triggers no autopilot.

type Env = SessionEnv & GithubIssueEnv;

const ROUTE = "/api/client-error";
const MAX_BODY = 16_384;
const ANON_MAX_BODY = 8_192;
// An anonymous report that names neither a frame in our own bundle nor a build asset is an
// extension's crash or a forgery, not a bug in this app; it may still be filed, but it costs most of
// the hour's budget. `source` is caller-controlled and only shifts 5 reports an hour to 1 — the cap
// itself is the control, not this.
const COST_APP_FRAME = 1;
const COST_NO_APP_FRAME = 4;

// A filter for casual noise, NOT a control: anyone can set an Origin header outside a browser. The
// control is the budget below. Content-type is deliberately not checked — sendBeacon sends
// text/plain, and a reporter that cannot flush on unload is worth more than the filter would be.
const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin");
  return !!origin && origin === new URL(request.url).origin;
};

const callerIp = (request: Request): string | null =>
  request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null;

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const session = await requireSession(request, env);
  const authed = !(session instanceof Response);

  if (!authed && !sameOrigin(request)) return new Response(null, { status: 403 });

  const text = await request.text();
  if (text.length > (authed ? MAX_BODY : ANON_MAX_BODY)) return new Response(null, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }

  const report = await toReport(body);

  if (!authed) {
    const ours = report.frames.some((f) => f.includes("/assets/")) || body.source === "boot-asset";
    const { allowed, reason } = await spendReportBudget(env.DB, env, callerIp(request), ours ? COST_APP_FRAME : COST_NO_APP_FRAME);
    // 204 rather than 429: a spammer is told nothing, and the boot guard has no use for the answer.
    if (!allowed) {
      logRequest({ route: ROUTE, status: 204, errorCode: `report_budget_${reason}` });
      return new Response(null, { status: 204 });
    }
  }

  const reportContext = { deployment: new URL(request.url).host, userAgent: (request.headers.get("user-agent") ?? "unknown").slice(0, 200) };
  if (!env.CLIENT_ERROR_GITHUB_TOKEN || !env.CLIENT_ERROR_GITHUB_REPO) {
    console.error("client-error (no GitHub sink configured)", JSON.stringify({ ...report, ...reportContext }));
    return new Response(null, { status: 204 });
  }
  try {
    await fileClientError(env, report, reportContext, authed ? "client-error" : "pre-auth");
  } catch (e) {
    // The sink dying is itself a failure nobody would otherwise see: the client is told 204 either
    // way, and an empty tracker reads exactly like a quiet week. This line is what
    // scripts/error-pipeline-check.ts and a `wrangler pages deployment tail` grep look for.
    logRequest({ route: ROUTE, status: 500, errorCode: "github_dead" });
    console.error("client-error: filing failed", (e as Error).message, JSON.stringify(report));
  }
  return new Response(null, { status: 204 });
}

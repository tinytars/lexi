import { requireSession, type SessionEnv } from "../_lib/session";
import { fingerprintOf, scrubMessage } from "../_lib/client-error";
import { fileReport, type GithubIssueEnv } from "../_lib/github-issue";
import { spendReportBudget } from "../_lib/report-budget";
import { logRequest } from "../_lib/log";
import { json } from "../_lib/http";
import { callerIp } from "../_lib/caller-ip";

// DPG 9B.3/9B.4/9B.6 and 9C.2 — the channel a user tells a human something is wrong through: an
// answer that looks dangerous, illegal material, or a clinician abusing their access. See
// MODERATION.md for who reads these and how fast.
//
// It rides the crash-report pipeline (github-issue.ts, report-budget.ts) rather than an inbox,
// because that pipeline already dedupes, rate-limits, scrubs and — the part an email cannot do —
// timestamps its own open and close, which is what makes the stated response time measurable.
//
// THE BODY CARRIES NO HEALTH CONTENT, by design and not by filtering: the route is never sent a
// document, a record, a client name or a marker value. A reviewer gets an account id and asks its
// owner. The one free-text field is scrubbed like a crash message, because a user describing a bad
// answer will quote it.

type Env = SessionEnv & GithubIssueEnv;

const ROUTE = "/api/report";
const MAX_BODY = 4_096;
const COST = 1;

// Each reason is a different obligation with a different reader, which is why the label is part of
// the filing rather than a word in the body: `kind:illegal-content` is what a triage query sorts on.
const REASONS = {
  "misleading-answer": "an answer that could mislead or harm",
  "illegal-content": "illegal or abusive material",
  "abusive-account": "an account behaving abusively",
} as const;
export type ReportReason = keyof typeof REASONS;

const isReason = (v: unknown): v is ReportReason => typeof v === "string" && v in REASONS;
// An id we generated: a message id, a feature name, an account id. Anything else is dropped rather
// than scrubbed — it has no business being in this field and a mask would only hide that.
const ID = /^[\w:.-]{1,64}$/;
const idOr = (v: unknown, fallback = ""): string => (typeof v === "string" && ID.test(v) ? v : fallback);

interface SafetyReport {
  reason: ReportReason;
  /** Who is reporting. The only way a reviewer can come back and ask; never a name or an address. */
  reportedBy: string;
  /** What it is about: a message id, or for 9C.2 the account complained of. Empty when neither applies. */
  subject: string;
  feature: string;
  note: string;
}

function body(r: SafetyReport, deployment: string): string {
  return [
    `**Reason:** ${REASONS[r.reason]} (\`${r.reason}\`)`,
    `**Reported by:** account \`${r.reportedBy}\``,
    ...(r.subject ? [`**About:** \`${r.subject}\``] : []),
    ...(r.feature ? [`**Where:** \`${r.feature}\``] : []),
    "",
    r.note ? `> ${r.note}` : "_No description given._",
    "",
    `- Deployment: \`${deployment}\``,
    `- Filed: ${new Date().toISOString()}`,
    "",
    "_Filed from LexiTar's in-app report control (`functions/api/report.ts`). It carries no health content: the reporter's own words are scrubbed and nothing from their record is sent. Reply by contacting the account above — see `apps/lexitar/MODERATION.md`._",
  ].join("\n");
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  // Session-gated, unlike /api/client-error: a crash report is worth taking from anyone, an
  // accusation about another account is not.
  const session = await requireSession(request, env);
  if (session instanceof Response) {
    logRequest({ route: ROUTE, status: 401, errorCode: "unauthorized" });
    return session;
  }

  const text = await request.text();
  if (text.length > MAX_BODY) {
    logRequest({ route: ROUTE, status: 413, errorCode: "too_large" });
    return json(413, { error: "report too long", errorCode: "too_large" });
  }
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(text);
  } catch {
    logRequest({ route: ROUTE, status: 400, errorCode: "bad_json" });
    return json(400, { error: "expected JSON", errorCode: "bad_json" });
  }
  if (!isReason(input.reason)) {
    logRequest({ route: ROUTE, status: 400, errorCode: "bad_reason" });
    return json(400, { error: `reason must be one of ${Object.keys(REASONS).join(", ")}`, errorCode: "bad_reason" });
  }

  const report: SafetyReport = {
    reason: input.reason,
    reportedBy: session.accountId,
    subject: idOr(input.subject),
    feature: idOr(input.feature),
    note: scrubMessage(typeof input.note === "string" ? input.note : ""),
  };

  // The same complaint twice is one issue and a comment (fileReport dedupes on this), so the salt is
  // what makes two DIFFERENT complaints two issues: reporter and subject. Without the reporter in it,
  // every user's "misleading answer" would land on one stranger's issue.
  const fingerprint = await fingerprintOf("SafetyReport", report.reason, `${report.reportedBy}\n${report.subject}`);

  const { allowed, reason } = await spendReportBudget(env.DB, env, callerIp(request), COST);
  if (!allowed) {
    logRequest({ route: ROUTE, status: 429, errorCode: `report_budget_${reason}` });
    return json(429, { error: "too many reports from here in the last hour — try again later", errorCode: "rate_limited" });
  }

  if (!env.CLIENT_ERROR_GITHUB_TOKEN || !env.CLIENT_ERROR_GITHUB_REPO) {
    // A 202 would be a lie: nothing reached a human. The control says so and the user can still use
    // the address in MODERATION.md.
    logRequest({ route: ROUTE, status: 503, errorCode: "sink_unconfigured" });
    console.error("report (no GitHub sink configured)", JSON.stringify({ ...report, fingerprint }));
    return json(503, { error: "reporting is unavailable on this deployment", errorCode: "sink_unconfigured" });
  }

  try {
    // `safety-report` and not `client-error`: plover-factory's autopilot fixer only acts on the
    // latter (.github/workflows/fix.yml), so nothing here is ever auto-patched by a bot.
    await fileReport(env, {
      title: `Safety report: ${report.reason} [${fingerprint}]`,
      body: body(report, new URL(request.url).host),
      fingerprint,
      labels: ["safety-report", `kind:${report.reason}`],
    });
  } catch (e) {
    // Told, not swallowed: a user who reported something dangerous and got a quiet 202 has been
    // misled about whether anyone will see it.
    logRequest({ route: ROUTE, status: 502, errorCode: "sink_dead" });
    console.error("report: filing failed", (e as Error).message, JSON.stringify({ ...report, fingerprint }));
    return json(502, { error: "could not file the report — please try again", errorCode: "sink_dead" });
  }

  logRequest({ route: ROUTE, status: 202, errorCode: undefined });
  return json(202, { filed: true, reference: fingerprint });
}

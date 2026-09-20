// The server twin of the browser error reporter: an exception that escapes a Pages Function becomes a
// GitHub issue instead of an unreported 500. Before this, a thrown D1 or R2 error — every vault
// save, every chat-history write — existed only as a 1101 on a dashboard nobody opens.
//
// HARD RULE: never PHI. A server message can carry more than a browser's ever does (an R2 key embeds
// the client slug and a document name; a vendor SDK error can quote the patient's own question), so
// scrubbing goes through functions/_lib/client-error.ts — the one trust boundary — and inference
// routes report a classified code with no vendor text at all.

import { fingerprintOf, scrubFrames, scrubServerMessage } from "./client-error";
import { fileReport, type GithubIssueEnv } from "./github-issue";
import { logRequest } from "./log";
import { classifyModelError } from "./model-errors";
import { ROUTE_PATTERNS } from "./route-patterns";

export interface ServerErrorContext {
  route: string; // a ROUTE_PATTERNS entry, never a live pathname
  method: string;
  deployment: string;
  requestId?: string;
  detail?: "scrubbed" | "code-only";
}

export interface ServerErrorReport {
  name: string;
  message: string;
  frames: string[];
  fingerprint: string;
}

export type ServerErrorEnv = GithubIssueEnv;

const NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

// Only the STATIC segments of real routes survive path masking — they are code. Everything else in a
// path position is data until proven otherwise.
const STATIC_SEGMENTS: ReadonlySet<string> = new Set(
  ROUTE_PATTERNS.flatMap((p) => p.split("/").filter((s) => s && !s.startsWith(":"))),
);

const MATCHERS = ROUTE_PATTERNS.map((pattern) => ({ pattern, segments: pattern.split("/").filter(Boolean) }));

/** The pattern a live pathname belongs to, or null. ROUTE_PATTERNS is already specificity-ordered. */
export function routePatternFor(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  for (const { pattern, segments } of MATCHERS) {
    let ok = true;
    for (let i = 0; i < segments.length && ok; i++) {
      const seg = segments[i];
      if (seg.endsWith("*")) return pattern;
      if (i >= parts.length) ok = false;
      else if (!seg.startsWith(":") && seg !== parts[i]) ok = false;
    }
    if (ok && parts.length === segments.length) return pattern;
  }
  return null;
}

// A vendor error on one of these can echo the request — which on /api/chat is the patient's question.
// They report the classified code and the thrown type, both of which are code, and nothing else.
const INFERENCE_ROUTES: ReadonlySet<string> = new Set([
  "/api/chat",
  "/api/document-extract",
  "/api/extract",
  "/api/leaf-regen",
  "/api/persona-adapt",
  "/api/refresh-finding",
  "/api/refresh-marker-groups",
  "/api/refresh-range",
  "/api/speak",
  "/api/treatment-infer",
]);

export const detailFor = (route: string): "scrubbed" | "code-only" => (INFERENCE_ROUTES.has(route) ? "code-only" : "scrubbed");

export async function toServerReport(error: unknown, ctx: ServerErrorContext): Promise<ServerErrorReport> {
  const e = error as { name?: unknown; message?: unknown; stack?: unknown };
  const name = typeof e?.name === "string" && NAME.test(e.name) ? e.name : "Error";
  const message =
    ctx.detail === "code-only"
      ? `${classifyModelError(error).errorCode} (${name})`
      : scrubServerMessage(typeof e?.message === "string" ? e.message : String(error), STATIC_SEGMENTS);
  const frames = scrubFrames(typeof e?.stack === "string" ? e.stack : "");
  return { name, message, frames, fingerprint: await fingerprintOf(name, message, ctx.route) };
}

function occurrence(r: ServerErrorReport, ctx: ServerErrorContext): string {
  const stack = r.frames.length ? r.frames.map((f) => `    at ${f}`).join("\n") : "    (no stack frames)";
  return [
    `**${r.name}:** ${r.message || "(no message)"}`,
    "",
    "```",
    stack,
    "```",
    "",
    `- Route: \`${ctx.method} ${ctx.route}\``,
    `- Deployment: \`${ctx.deployment}\``,
    `- Request: \`${ctx.requestId ?? "unknown"}\``,
    `- Seen: ${new Date().toISOString()}`,
    "",
    ctx.detail === "code-only"
      ? "_Filed automatically by LexiTar's server error sink (`functions/api/_middleware.ts`). This route talks to a model provider, whose errors can quote the request, so only the classified code is reported._"
      : "_Filed automatically by LexiTar's server error sink (`functions/api/_middleware.ts`). Message and stack are PHI-scrubbed._",
  ].join("\n");
}

// A route that fails on every request must not file thousands of issues; one isolate reports each
// distinct failure once. The cap stops a pathological loop from growing the set without bound.
const MAX_FINGERPRINTS = 50;
const seen = new Set<string>();

/**
 * Reports an exception that escaped a handler. NEVER throws and never rejects — it is called from a
 * catch block and from waitUntil, where a second failure would be invisible anyway.
 */
export async function reportServerError(env: ServerErrorEnv, error: unknown, ctx: ServerErrorContext): Promise<"filed" | "deduped" | "logged"> {
  try {
    // The log line goes out first and unconditionally: it is the signal that survives a dead GitHub.
    logRequest({ route: ctx.route, status: 500, requestId: ctx.requestId, errorCode: "unhandled" });

    const report = await toServerReport(error, ctx);
    if (seen.has(report.fingerprint)) return "deduped";
    if (seen.size < MAX_FINGERPRINTS) seen.add(report.fingerprint);

    if (!env.CLIENT_ERROR_GITHUB_TOKEN || !env.CLIENT_ERROR_GITHUB_REPO) {
      console.error("server-error (no GitHub sink configured)", JSON.stringify({ ...report, ...ctx }));
      return "logged";
    }
    await fileReport(env, {
      title: `Server error: ${ctx.route} — ${report.name} [${report.fingerprint}]`,
      body: occurrence(report, ctx),
      fingerprint: report.fingerprint,
      labels: ["server-error"],
    });
    return "filed";
  } catch (e) {
    // Sealed: a throw in here would recurse through the middleware that called it.
    console.error("server-error: reporting failed", (e as Error)?.message);
    return "logged";
  }
}

/** Test seam: the dedupe set is module state, which would otherwise leak between cases. */
export function resetServerErrorDedupe(): void {
  seen.clear();
}

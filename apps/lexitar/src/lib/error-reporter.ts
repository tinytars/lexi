import { onLazyImportFailure } from "./lazy-import";

// Forwards uncaught errors, unhandled rejections, failed lazy chunk loads and explicitly reported
// handled failures to /api/client-error, which files them as GitHub issues. Before this, a crash like
// each_key_duplicate existed only in the one browser console that saw it. PHI scrubbing happens server-side (functions/_lib/client-error.ts) — the trust boundary.

export interface ClientErrorPayload {
  name: string;
  message: string;
  stack: string;
  build: string;
}

// Cloudflare Pages sets CF_PAGES_COMMIT_SHA at build time (vite.config.ts); without it the minified
// frames in a report can't be mapped back to source.
const BUILD: string = import.meta.env.VITE_BUILD_SHA ?? "";

// A crash inside a render loop can throw every frame; one page load reports each distinct error once,
// and at most this many in total.
const MAX_REPORTS_PER_PAGE = 5;

function send(payload: ClientErrorPayload): void {
  void fetch("/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}

// index.html's boot guard defines it: reload once onto the current build, loop-guarded.
const reloadForCurrentBuild = () => (globalThis as { reloadForCurrentBuild?: () => void }).reloadForCurrentBuild?.();

const seen = new Set<string>();
let sink: (p: ClientErrorPayload) => void = send;

function capture(err: unknown): void {
  // A cross-origin script error arrives as a bare "Script error." with no Error object — nothing to act on.
  if (err === undefined || err === null) return;
  const e = err instanceof Error ? err : new Error(String(err));
  const signature = `${e.name}: ${e.message}`;
  if (seen.has(signature) || seen.size >= MAX_REPORTS_PER_PAGE) return;
  seen.add(signature);
  sink({ name: e.name, message: e.message, stack: e.stack ?? "", build: BUILD });
}

// For a failure the app caught and showed the user but that nobody would otherwise report. It shares
// the budget above, so handled failures can never crowd out a crash.
export function reportCaughtError(err: unknown): void {
  capture(err);
}

// A 5xx is the one failure the server's own sink can miss entirely: the platform can answer before
// any handler runs, and only the browser sees that. Wrapping fetch reports every route at once
// instead of threading a report through the sixteen call sites that make these requests — and
// skips what a handler classified itself, which is the middleware's rule applied from this side.
const SINK_PATH = "/api/client-error";

// The path is a message field, so it must be code, not data: an id segment can be a vault slug.
function maskApiPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length > 2 ? `/${parts[0]}/${parts[1]}/…` : pathname;
}

// The middleware's rule, read from this side: a handler that answers with its own `errorCode` has
// classified the failure, so it is a condition the app expects rather than a defect. `ai_busy` is
// why this matters — the vendor answering 429/503/529 is a 503 here, which the app retries and
// explains, and filing one as a bug also pins the promotion gate on a build no fix can clear.
//
// Reading that body is itself inside the caller's deadline (ai-error.ts's withDeadline aborts the
// request, and this read runs before the response is handed back), so a body that stops arriving is
// NOT evidence the handler classified nothing — it is evidence nobody was left waiting for it. Only
// a read that failed on a request nobody cancelled says anything about the route.
async function classifiedByHandler(res: Response, signal?: AbortSignal | null): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { errorCode?: unknown } | null;
    return typeof body?.errorCode === "string";
  } catch {
    return signal?.aborted === true;
  }
}

export function installApiFailureReporting(
  scope: { fetch: typeof fetch } = globalThis,
  origin: string = location.origin,
): void {
  const inner = scope.fetch;
  scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    if (res.status < 500) return res;
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (url.origin !== origin || !url.pathname.startsWith("/api/") || url.pathname === SINK_PATH) return res;
    if (await classifiedByHandler(res, input instanceof Request ? input.signal : init?.signal)) return res;
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    const failure = new Error(`${method} ${maskApiPath(url.pathname)} → ${res.status}`);
    failure.name = "ApiUnavailable";
    capture(failure);
    return res;
  };
}

export function installErrorReporter(
  target: EventTarget = window,
  report: (p: ClientErrorPayload) => void = send,
  reload: () => void = reloadForCurrentBuild,
): void {
  seen.clear();
  sink = report;
  target.addEventListener("error", (ev) => capture((ev as ErrorEvent).error));
  target.addEventListener("unhandledrejection", (ev) => capture((ev as PromiseRejectionEvent).reason));
  onLazyImportFailure((err) => {
    capture(err);
    reload();
  });
}

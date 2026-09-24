import { aiAvailability } from "./ai-availability.svelte";
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

const SINK_PATH = "/api/client-error";

// W85 — the sink is a Pages Function on the same deployment as the code it reports on, so it goes
// down with it: the 503 that broke the app is also the 503 that loses the report of it. Nothing here
// checked `res.ok`, so a dropped report resolved like a delivered one and the only evidence of an
// incident stayed in one browser console.
//
// A buffered report waits in sessionStorage rather than memory, because the page that holds it is
// usually the page that is about to be reloaded.
const BUFFER_KEY = "client-error-retry";
const MAX_BUFFERED = 10;
// The server's own per-report ceiling (functions/api/client-error.ts MAX_BODY). A payload that could
// never be accepted is not worth a slot.
const MAX_BUFFERED_BYTES = 16_384;
const MAX_ATTEMPTS = 2;

interface BufferedReport extends ClientErrorPayload {
  attempts: number;
}

// sessionStorage throws outright in some privacy modes. The guards are not decoration: writeBuffer
// runs on the REPORTING path, so an escaping throw becomes a fresh unhandled rejection, which this
// module listens for, captures, and tries to buffer again. Swallowing here is what stops one denied
// write from becoming a loop.
function readBuffer(): BufferedReport[] {
  try {
    const raw = sessionStorage.getItem(BUFFER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as BufferedReport[]) : [];
  } catch {
    return [];
  }
}

function writeBuffer(reports: BufferedReport[]): void {
  try {
    sessionStorage.setItem(BUFFER_KEY, JSON.stringify(reports.slice(-MAX_BUFFERED)));
  } catch {
    /* full, or storage denied — the report is lost, which is where we started */
  }
}

// `attempts` counts deliveries already made, so the guard is on what the stored entry would become:
// MAX_ATTEMPTS is the total the sink ever sees, not the number of retries on top of it.
function buffer(payload: ClientErrorPayload, attempts: number): void {
  if (attempts + 1 >= MAX_ATTEMPTS) return;
  const entry: BufferedReport = { ...payload, attempts: attempts + 1 };
  if (JSON.stringify(entry).length > MAX_BUFFERED_BYTES) return;
  writeBuffer([...readBuffer(), entry]);
}

/**
 * Whether a failed POST is worth keeping. 204 is the only success the sink returns, and it covers
 * accepted, budget-spent and sink-unconfigured alike. 400/413 are verdicts on the payload itself and
 * 403 on the caller, so all three are identical next time; a 5xx, a 429 and a network throw are
 * verdicts on the moment.
 */
function worthRetrying(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

async function post(payload: ClientErrorPayload): Promise<number | null> {
  try {
    const res = await fetch(SINK_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    return res.status;
  } catch {
    return null; // offline, or the request never left
  }
}

async function deliver({ attempts, ...payload }: BufferedReport): Promise<void> {
  const status = await post(payload);
  if (status !== null && !worthRetrying(status)) return;
  buffer(payload, attempts);
}

function send(payload: ClientErrorPayload): void {
  void deliver({ ...payload, attempts: 0 });
}

/**
 * Drains what an earlier page could not deliver. Each report keeps the `build` it was captured on:
 * re-stamping it with the current build would file the bug against whichever deployment happened to
 * load next — and pin the promotion gate on a build that never had the defect.
 */
async function flushBuffer(): Promise<void> {
  const pending = readBuffer();
  if (!pending.length) return;
  writeBuffer([]);
  for (const report of pending) await deliver(report);
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

// The path is a message field, so it must be code, not data: an id segment can be a vault slug.
function maskApiPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length > 2 ? `/${parts[0]}/${parts[1]}/…` : pathname;
}

// What answered this 5xx, as far as the browser can tell.
//
// "skip" is the middleware's rule read from this side: an answer carrying its own `errorCode` is one
// the server already accounted for, so reporting it here would file a second issue for one event.
// `ai_busy` is why that matters — the vendor answering 429/503/529 is a 503 here, which the app
// retries and explains, and filing one as a bug also pins the promotion gate on a build no fix can
// clear. The catch-all's `unhandled` is the same rule: reportServerError filed it as a
// `server-error` before the 500 was written, so a `client-error` twin adds nothing and gates.
//
// W86 — "platform" is the case this module was written for and could not name. A handler's reply is
// JSON; Cloudflare's is not. An isolate killed for exceeding its memory, a deployment mid-rollout,
// a route with no Function behind it: each answers with an error page this repo never wrote, and the
// kill takes down every request in flight at once, whatever it was doing. One such event used to
// file up to five separately-fingerprinted "client bugs" and send an autopilot after each of them,
// looking for a defect in code that was working. Naming it here is what lets the sink label it.
type FiveHundred = "skip" | "handler" | "platform";

async function fiveHundredKind(res: Response): Promise<FiveHundred> {
  if (!(res.headers.get("content-type") ?? "").includes("json")) return "platform";
  try {
    const body = (await res.clone().json()) as { errorCode?: unknown } | null;
    return typeof body?.errorCode === "string" ? "skip" : "handler";
  } catch (e) {
    // The caller walked away mid-read. There is no answer left to classify, and nobody is waiting on
    // the request it belonged to — reporting it would file the abort, not the failure.
    return (e as Error | undefined)?.name === "AbortError" ? "skip" : "handler";
  }
}

// A 5xx is the one failure the server's own sink can miss entirely: the platform can answer before
// any handler runs, and only the browser sees that. Wrapping fetch reports every route at once
// instead of threading a report through the sixteen call sites that make these requests — and
// skips what a handler classified itself, which is the middleware's rule applied from this side.
export function installApiFailureReporting(
  scope: { fetch: typeof fetch } = globalThis,
  origin: string = location.origin,
): void {
  const inner = scope.fetch;
  scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    // The URL is parsed for every answered request now, not just the 5xx ones: the availability latch
    // reads a 402 the reporter deliberately ignores. `fetch` already accepted this input, so there is
    // no parse to fail here.
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (url.origin !== origin || !url.pathname.startsWith("/api/") || url.pathname === SINK_PATH) return res;
    aiAvailability.observe(url.pathname, res.status);
    if (res.status < 500) return res;
    const kind = await fiveHundredKind(res);
    if (kind === "skip") return res;
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    const failure = new Error(`${method} ${maskApiPath(url.pathname)} → ${res.status}`);
    // The name is the fingerprint's first field and the issue's title, so the two cases separate all
    // the way into the tracker instead of arriving as one undifferentiated ApiUnavailable.
    failure.name = kind === "platform" ? "PlatformUnavailable" : "ApiUnavailable";
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
  // Drained ahead of this page's own errors, and only when the real sink is in play: a caller that
  // injected its own `report` is not talking to /api/client-error, so it has no buffer to drain.
  if (report === send) void flushBuffer();
  target.addEventListener("error", (ev) => capture((ev as ErrorEvent).error));
  target.addEventListener("unhandledrejection", (ev) => capture((ev as PromiseRejectionEvent).reason));
  onLazyImportFailure((err) => {
    capture(err);
    reload();
  });
}

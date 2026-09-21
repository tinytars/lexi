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

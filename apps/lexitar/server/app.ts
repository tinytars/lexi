import { detailFor, reportServerError, routePatternFor, type ServerErrorContext, type ServerErrorEnv } from "../functions/_lib/server-error";
import type { LoadedRoute } from "./routes";
import { selectHandler } from "./routes";

export type Fetch = (request: Request) => Promise<Response>;
export type ReportError = (env: ServerErrorEnv, error: unknown, ctx: ServerErrorContext) => Promise<unknown>;

// One request through the Node host, as Pages would take it: a matching Function answers; anything
// else — including an /api path no Function claims — falls through to static assets. The catch is the
// self-host's twin of functions/api/_middleware.ts, which discoverRoutes() skips as a `_` file.
export function createApp({
  routes,
  env,
  assets,
  report = reportServerError,
}: {
  routes: LoadedRoute[];
  env: Record<string, unknown>;
  assets: Fetch;
  report?: ReportError;
}): Fetch {
  const context = { ...env, ASSETS: { fetch: assets } };
  const serverEnv = env as ServerErrorEnv;
  const describe = (request: Request, pathname: string): ServerErrorContext => {
    const route = routePatternFor(pathname) ?? "/api/(unmatched)";
    return { route, method: request.method, deployment: new URL(request.url).host, detail: detailFor(route) };
  };
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    // A background task that fails is a failure like any other — it just has no response to carry it.
    const waitUntil = (p: Promise<unknown>) => {
      p.catch((e) => void report(serverEnv, e, { ...describe(request, pathname), route: "(waitUntil)" }));
    };
    const hit = selectHandler(routes, request.method, pathname);
    if (!hit) return assets(request);
    try {
      return await hit.handler({ request, env: context, params: hit.params, waitUntil });
    } catch (e) {
      // The operator's own stderr keeps the unscrubbed error; only the reported copy is scrubbed.
      console.error(`${request.method} ${pathname} threw:`, e);
      void report(serverEnv, e, describe(request, pathname));
      return new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "content-type": "application/json" } });
    }
  };
}

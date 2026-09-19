import type { LoadedRoute } from "./routes";
import { selectHandler } from "./routes";

export type Fetch = (request: Request) => Promise<Response>;

// One request through the Node host, as Pages would take it: a matching Function answers; anything
// else — including an /api path no Function claims — falls through to static assets.
export function createApp({ routes, env, assets }: { routes: LoadedRoute[]; env: Record<string, unknown>; assets: Fetch }): Fetch {
  const context = { ...env, ASSETS: { fetch: assets } };
  const waitUntil = (p: Promise<unknown>) => {
    p.catch((e) => console.error("waitUntil task failed:", e));
  };
  return async (request) => {
    const hit = selectHandler(routes, request.method, new URL(request.url).pathname);
    if (!hit) return assets(request);
    try {
      return await hit.handler({ request, env: context, params: hit.params, waitUntil });
    } catch (e) {
      console.error(`${request.method} ${new URL(request.url).pathname} threw:`, e);
      return new Response("Internal Server Error", { status: 500 });
    }
  };
}

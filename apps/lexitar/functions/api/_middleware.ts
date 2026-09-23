import { json } from "../_lib/http";
import { detailFor, reportServerError, routePatternFor, type ServerErrorEnv } from "../_lib/server-error";

// The one catch block for all 64 routes. It lives at functions/api/ and NOT at functions/ on purpose:
// Pages derives _routes.json from this tree, and a root middleware would set include:["/*"], paying a
// Worker invocation for every chunk, font and favicon. Here it yields include:["/api/*"].
//
// Only a THROWN error is reported. A handler that returns its own 500 has already classified the
// failure; re-reporting it would file issues for conditions the code already understands.
//
// The 500 below carries `errorCode: "unhandled"` — the same word server-error.ts already logs for
// this condition — because reportServerError has just filed the event as a `server-error`. It is
// what tells the browser's installApiFailureReporting not to file it a SECOND time as a
// `client-error`, which gates promotion and wakes the autopilot on a bug already in the tracker.

export async function onRequest(context: {
  request: Request;
  env: ServerErrorEnv;
  next: () => Promise<Response>;
  waitUntil: (p: Promise<unknown>) => void;
}): Promise<Response> {
  try {
    return await context.next();
  } catch (error) {
    const url = new URL(context.request.url);
    const route = routePatternFor(url.pathname) ?? "/api/(unmatched)";
    // waitUntil, so two GitHub round trips never sit between the patient and their error page.
    context.waitUntil(
      reportServerError(context.env, error, {
        route,
        method: context.request.method,
        deployment: url.host,
        requestId: context.request.headers.get("cf-ray") ?? undefined,
        detail: detailFor(route),
      }),
    );
    return json(500, { error: "internal error", errorCode: "unhandled" });
  }
}

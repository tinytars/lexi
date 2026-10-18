import type { D1Database } from "../../_lib/identity-types";
import { listRecentAccessEventsForSubject } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { json } from "../../_lib/http";

// W55 P4 — the patient-visible side of phi_access_events: newest first, capped at 200. The cap is applied
// in SQL (listRecentAccessEventsForSubject), not by slicing a whole history in the isolate — privileged
// reads now write a row per object, so a history is unbounded even when the screen is not.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/account/access-events";
const CAP = 200;

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const events = await listRecentAccessEventsForSubject(env.DB, session.accountId, CAP);

  log(200);
  return json(200, { events });
}

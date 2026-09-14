import type { D1Database } from "../../_lib/identity-types";
import { listAccessEventsForSubject } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";

// W55 P4 — the patient-visible side of phi_access_events: newest first, capped at 200. First caller of
// listAccessEventsForSubject, which orders ascending with no limit.
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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const events = (await listAccessEventsForSubject(env.DB, session.accountId)).slice(-CAP).reverse();

  log(200);
  return json(200, { events });
}

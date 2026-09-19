import type { D1Database } from "../../_lib/identity-types";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { json } from "../../_lib/http";
import { readPersonaId } from "../../../src/lib/personas";

// W84 — the account's persona. Its own route rather than a field on /api/account because that route's
// store is @tinytars/vault's domain-neutral D1AccountStore; a voice preference is this app's concern.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/account/persona";

export async function onRequestGet({ request, env }: Ctx): Promise<Response> {
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });
  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const row = await env.DB.prepare("SELECT persona FROM accounts WHERE id = ?").bind(session.accountId).first<{ persona: string | null }>();
  log(200);
  return json(200, { persona: readPersonaId(row?.persona) });
}

export async function onRequestPut({ request, env }: Ctx): Promise<Response> {
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });
  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const body = (await request.json().catch(() => null)) as { persona?: unknown } | null;
  const persona = readPersonaId(body?.persona);
  if (!persona) { log(400, "bad_persona"); return json(400, { error: "unknown persona" }); }

  await env.DB.prepare("UPDATE accounts SET persona = ? WHERE id = ?").bind(persona, session.accountId).run();
  log(200);
  return json(200, { persona });
}

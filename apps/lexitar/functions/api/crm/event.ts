import type { D1Database } from "../../_lib/identity-types";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { emitLifecycleEvent } from "../../_lib/lifecycle";
import { isBillingDrivenEvent } from "../../../src/lib/lifecycle";

// W44 P5 — the CRM event seam's HTTP entry (STUB). Records a lifecycle event for the caller's own
// account via emitLifecycleEvent; NO external calls fire. This is where the future Stripe-webhook /
// Salesforce fan-out will hang. Billing-driven events (paying/churned) are rejected here — those come
// from the (unbuilt) Stripe webhook, not a client, so a client can't self-promote to `paying`.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/crm/event";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }

  let body: { event?: unknown; meta?: unknown };
  try {
    body = await request.json();
  } catch {
    log(400, "bad_json");
    return json(400, { error: "invalid JSON" });
  }
  if (typeof body.event !== "string" || !body.event) {
    log(400, "bad_body");
    return json(400, { error: "event required" });
  }
  if (isBillingDrivenEvent(body.event)) {
    log(403, "billing_event");
    return json(403, { error: "billing-driven events come from the payment webhook, not the client" });
  }

  const meta = (body.meta && typeof body.meta === "object" ? body.meta : {}) as Record<string, unknown>;
  const row = await emitLifecycleEvent(env.DB, session.accountId, body.event, meta);
  if (!row) {
    log(404, "not_found");
    return json(404, { error: "account not found" });
  }

  log(200);
  return json(200, { event: row });
}

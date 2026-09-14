import { requireBearer } from "../_lib/guard";
import { auditor, type AuditEvent } from "../_lib/audit";

// W39/Phase 3 — client loop-event beacon. The retry loop lives browser-side (refresh-client.ts), so
// its decisions (why it retried, when it gave up, a cancel) are invisible to the server half of the
// audit trail. This PROVIDER_TOKEN-gated sink lets the browser append those loop events to the SAME
// R2 log the refresh Function writes, so a provider sees the whole story.
//
// HARD RULE: never PHI. The entry is reconstructed from a STRICT allowlist of PHI-free scalars — the
// raw body is NEVER echoed. `reasonCategory`/`errorCode` are additionally regex-gated to short slugs,
// so a correction string (model prose about the patient) cannot slip through even if a buggy client
// sent one.

interface R2Bucket {
  put(key: string, value: string, options?: unknown): Promise<unknown>;
}
interface Env {
  PROVIDER_TOKEN: string;
  VAULT?: R2Bucket;
  STORE_PREFIX: string;
}

const ROUTE = "/api/refresh-finding"; // beacon events belong to the refresh-finding trail
const CLIENT_EVENTS: readonly AuditEvent[] = ["truncated", "validation-fail", "success", "gave-up", "cancelled"];
const SLUG = /^[a-z0-9_-]{1,40}$/; // a category/code, never prose (no spaces/punctuation)

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  if (requireBearer(request, env.PROVIDER_TOKEN)) return json(401, { error: "unauthorized" });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json(400, { error: "malformed JSON body" });
  }
  const event = body.event;
  if (typeof event !== "string" || !CLIENT_EVENTS.includes(event as AuditEvent)) {
    return json(400, { error: "unknown or missing event" });
  }
  const slug = (v: unknown): string | undefined => (typeof v === "string" && SLUG.test(v) ? v : undefined);

  const requestId = request.headers.get("cf-ray") ?? undefined;
  const audit = auditor(env.VAULT, env, ROUTE, requestId);
  await audit({
    event: event as AuditEvent,
    status: 204,
    attempt: typeof body.attempt === "number" ? body.attempt : undefined,
    errorCode: slug(body.errorCode),
    reasonCategory: slug(body.reasonCategory),
    latencyMs: typeof body.latencyMs === "number" ? body.latencyMs : undefined,
  });
  return new Response(null, { status: 204 });
}

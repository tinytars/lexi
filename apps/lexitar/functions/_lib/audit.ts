// W39/Phase 3 — persisted, PHI-free refresh audit trail. Sits alongside log.ts: in addition to the
// ephemeral console.log, it appends a structured entry to R2 so a provider can reconstruct what a
// refresh did AFTER the fact (no live `wrangler pages deployment tail`, no redeploy). R2 has no native
// append, so we write ONE small object per event under a dated prefix; the reader (Phase 4) lists +
// reads the tail, which sidesteps read-modify-write races on a shared key.
//
// HARD RULE (same as log.ts): never PHI. No client bytes, no question/answer prose, and — critically —
// never the correction STRING (model text reasoning about the patient). Only shape / outcome / cost /
// a correction *category*.

import { logRequest, type RequestLog } from "./log";
import { storeKey, type StoreEnv } from "./store";

export type AuditEvent =
  | "accepted" // server: request passed the guard, generation about to start
  | "stream-done" // server: a generation completed (carries usage — the real cost)
  | "error" // server: the Anthropic stream failed post-header
  | "aborted" // server: the browser cancelled/disconnected mid-stream
  | "truncated" // client: the stream was cut off (unparseable) — terminal, no retry
  | "validation-fail" // client: a well-formed candidate failed validation — a correction retry follows
  | "success" // client: the assembled Finding validated
  | "gave-up" // client: all K attempts exhausted without a valid Finding
  | "cancelled"; // client: the provider hit Cancel

export interface AuditEntry extends RequestLog {
  event: AuditEvent;
  attempt?: number; // which attempt (1..K) this event belongs to
  chars?: number; // streamed text length — a size, never the text
  reasonCategory?: string; // a CATEGORY of a retry (e.g. "validation"), NEVER the correction prose
}

interface R2PutBucket {
  put(key: string, value: string, options?: unknown): Promise<unknown>;
}

// R2 key for one event: <prefix>/logs/<route-slug>/<yyyy-mm-dd>/<requestId>-<seq>.json. Newest-first
// ordering is reconstructed by the reader from the `at` timestamp inside each object (Phase 4).
function auditKey(env: StoreEnv, route: string, requestId: string, seq: number, day: string): string {
  const slug = route.replace(/^\/api\//, "").replace(/[^a-z0-9-]/gi, "-");
  return storeKey(env, "logs", slug, day, `${requestId}-${seq}.json`);
}

// Returns a writer bound to one request that always console.logs (existing dashboard/tail path) and,
// when an R2 bucket is present, also persists one object per event. A missing bucket (e.g. a test env
// without VAULT) degrades to console-only. A log write NEVER throws into the request path.
export function auditor(
  bucket: R2PutBucket | undefined,
  env: StoreEnv,
  route: string,
  requestId: string | undefined,
): (entry: Omit<AuditEntry, "route" | "requestId">) => Promise<void> {
  let seq = 0;
  const rid = requestId ?? "noray";
  return async (entry) => {
    const full: AuditEntry = { route, requestId, ...entry };
    logRequest(full);
    if (!bucket) return;
    const at = new Date().toISOString();
    try {
      await bucket.put(auditKey(env, route, rid, seq++, at.slice(0, 10)), JSON.stringify({ at, ...full }));
    } catch {
      // A log write must never break the request it is logging — the console line above still landed.
    }
  };
}

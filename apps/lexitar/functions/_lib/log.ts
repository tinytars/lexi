// Structured request logging for Pages Functions — one JSON line per request, surfaced by
// the Cloudflare dashboard and `wrangler pages deployment tail`. The foundation the W8
// observability milestone builds on (audit trail, alerting, cost).
//
// HARD RULE: never log PHI. No question, context, answer, vault bytes, passphrase, or
// bearer ever goes in here — only request shape, outcome, latency, and token counts.

export interface RequestLog {
  route: string;
  status: number;
  // Optional because /api/log records CLIENT-reported events, where the browser may not have timed
  // anything — an omitted latency is honest, a 0 would be a measurement that never happened. Every
  // server-side logger computes it from its own `start`.
  latencyMs?: number;
  requestId?: string; // Cloudflare cf-ray, for correlating with CF logs
  usage?: { input: number; output: number }; // Anthropic token counts (cost), not content
  errorCode?: string; // short category (e.g. "unauthorized", "model_error") — never a message body
  id?: string; // vault slug for /api/vault writes (W8d audit) — pseudonymous, already in the URL
  bytes?: number; // encrypted-blob size for a vault write (W8d) — a count, NEVER the bytes themselves
  // W75 — the rawAccessFor() answer behind this request. An `orphaned` line is a refused patient the
  // backfill missed — a number to drive to zero, not an assumption. A kind, never an account id.
  access?: "owner" | "granted" | "unclaimed" | "orphaned" | "denied";
}

// The port's token counts are as nullable as the wire makes them — @pablotech/akesi/model-client's
// ModelUsage, where "an adapter that reports neither still fits" — and `usage` above is not nullable
// at all. Same rule as latencyMs: an omitted count is honest, a 0 is a measurement that never
// happened. So a reply that reported neither count logs no usage rather than a free call.
export function tokenUsage(usage: { input_tokens?: number | null; output_tokens?: number | null }): RequestLog["usage"] {
  const { input_tokens: input, output_tokens: output } = usage;
  return typeof input === "number" && typeof output === "number" ? { input, output } : undefined;
}

export function logRequest(entry: RequestLog): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
}

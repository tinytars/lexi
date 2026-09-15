// Maps a thrown Anthropic SDK error to the HTTP status + PHI-free errorCode the
// chat Function returns to the browser. Pure so it can be unit-tested headlessly
// (tests/unit/anthropic-errors.test.ts) without a live billable call. W7's
// higher-stakes triage route reuses this. Read fields defensively — the caught
// value may not be an Anthropic.APIError (network failure, thrown string, etc.).

export type ChatErrorCode = "insufficient_credit" | "ai_busy" | "anthropic_error";

export function classifyAnthropicError(err: unknown): { status: number; errorCode: ChatErrorCode } {
  const e = err as { status?: unknown; type?: unknown; error?: { type?: unknown }; message?: unknown };
  const status = typeof e?.status === "number" ? e.status : 0;
  const type = (typeof e?.type === "string" ? e.type : undefined) ?? (typeof e?.error?.type === "string" ? e.error.type : undefined);
  const message = typeof e?.message === "string" ? e.message : "";

  // Credit exhaustion surfaces as 400 invalid_request_error with a "credit balance
  // too low" message; the billing_error variant arrives as 403. 402 is defensive.
  if (status === 402 || type === "billing_error" || (status === 400 && /credit balance/i.test(message))) {
    return { status: 402, errorCode: "insufficient_credit" };
  }

  if (status === 429 || status === 529) {
    return { status: 503, errorCode: "ai_busy" };
  }

  return { status: 502, errorCode: "anthropic_error" };
}

// Maps a thrown model error, from any provider's adapter, to the HTTP status and PHI-free errorCode
// a route returns to the browser. Read fields defensively: the caught value may be an SDK error, an
// adapter's ModelHttpError, a network failure or a thrown string.
import { AI_ERROR_MESSAGES } from "../../src/lib/ai-error";

export type ModelErrorCode = "insufficient_credit" | "ai_busy" | "model_unsupported" | "model_error";

/** A request needs something (images, PDFs, tools, JSON schema) the configured model can't take. */
export class ModelUnsupportedError extends Error {
  readonly capability: string;
  constructor(capability: string) {
    super(`the configured model does not support ${capability}`);
    this.capability = capability;
    this.name = "ModelUnsupportedError";
  }
}

/** A non-2xx reply from an OpenAI-compatible server, shaped like the Anthropic SDK's APIError. */
export class ModelHttpError extends Error {
  readonly status: number;
  readonly type?: string;
  readonly code?: string;
  constructor(status: number, message: string, type?: string, code?: string) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.name = "ModelHttpError";
  }
}

export function classifyModelError(err: unknown): { status: number; errorCode: ModelErrorCode } {
  if (err instanceof ModelUnsupportedError) return { status: 422, errorCode: "model_unsupported" };
  const e = err as { status?: unknown; type?: unknown; code?: unknown; error?: { type?: unknown }; message?: unknown };
  const status = typeof e?.status === "number" ? e.status : 0;
  const type = (typeof e?.type === "string" ? e.type : undefined) ?? (typeof e?.error?.type === "string" ? e.error.type : undefined);
  const code = typeof e?.code === "string" ? e.code : undefined;
  const message = typeof e?.message === "string" ? e.message : "";

  // Anthropic: credit exhaustion is a 400 "credit balance too low", or a 403 billing_error.
  // OpenAI: a 429 whose code is insufficient_quota. 402 is defensive for either.
  if (
    status === 402 ||
    type === "billing_error" ||
    code === "insufficient_quota" ||
    type === "insufficient_quota" ||
    (status === 400 && /credit balance/i.test(message))
  ) {
    return { status: 402, errorCode: "insufficient_credit" };
  }

  if (status === 429 || status === 503 || status === 529) {
    return { status: 503, errorCode: "ai_busy" };
  }

  return { status: 502, errorCode: "model_error" };
}

/** A route's error reply for a failed model call; `fallback` names the route's generic failure. */
export function modelErrorReply(err: unknown, fallback: string): { status: number; errorCode: ModelErrorCode; error: string } {
  const { status, errorCode } = classifyModelError(err);
  return { status, errorCode, error: errorCode === "model_error" ? fallback : AI_ERROR_MESSAGES[errorCode] };
}

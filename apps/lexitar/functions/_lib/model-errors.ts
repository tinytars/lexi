// Maps a thrown model error, from any provider's adapter, to the HTTP status and PHI-free errorCode
// a route returns to the browser. Read fields defensively: the caught value may be an SDK error, an
// adapter's ModelHttpError, a network failure or a thrown string.
import { AI_ERROR_MESSAGES } from "../../src/lib/ai-error";
import { CorpusDeniedError, CorpusMissingError, CorpusTooLargeError, CorpusUnmeasuredError, type CorpusLimit } from "./inference/corpus-errors";

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

// ── The report corpus ────────────────────────────────────────────────────────
// A corpus failure is not a model failure — nothing was sent — but it reaches a route through the
// same catch, so the two are classified together. Every route calls `inferenceErrorReply` rather
// than `modelErrorReply`: catching these explicitly is what keeps them out of _middleware.ts, whose
// one catch block files a GitHub issue and answers a generic 500 for anything that escapes a route.

export type InferenceErrorCode = ModelErrorCode | "corpus_too_large" | "corpus_unmeasured" | "corpus_missing" | "not_found";

export interface InferenceErrorReply {
  status: number;
  errorCode: InferenceErrorCode;
  error: string;
  limit?: CorpusLimit;
  actual?: number;
  max?: number;
  unmeasured?: number;
}

// The same sentence on every corpus refusal, because it is the decision being reported: this app
// would rather answer nothing than answer from part of a record (CORPUS.md).
const NO_PARTIAL = "No answer was produced — an answer from part of the record would not be trustworthy.";

/** Bytes are the only ceiling whose raw number means nothing to the person reading the refusal. */
const amount = (limit: CorpusLimit, n: number): string =>
  limit === "bytes" ? `${Math.round(n / (1024 * 1024))} MB` : `${n} ${limit}`;

export function inferenceErrorReply(err: unknown, fallback: string): InferenceErrorReply {
  // 404, not 403: a 403 would confirm that a namespace exists, which is what raw/[[path]].ts refuses
  // to do. The caller learns only that there is nothing here for them.
  if (err instanceof CorpusDeniedError) return { status: 404, errorCode: "not_found", error: "not found" };

  // 422 rather than 413 throughout: on these routes 413 already means "your request body was too
  // big", and the remedy for that is not the remedy for this.
  if (err instanceof CorpusTooLargeError) {
    return {
      status: 422,
      errorCode: "corpus_too_large",
      error: `This record holds ${amount(err.limit, err.actual)} of source documents; one request can carry at most ${amount(err.limit, err.max)}. ${NO_PARTIAL}`,
      limit: err.limit,
      actual: err.actual,
      max: err.max,
    };
  }
  // The count, never the file names: this body is read by a browser and a file name is PHI.
  if (err instanceof CorpusUnmeasuredError) {
    return {
      status: 422,
      errorCode: "corpus_unmeasured",
      error: `${err.files.length} of this record's source documents have not been measured yet, so they cannot all be sent. ${NO_PARTIAL} Reopening the record repairs this.`,
      unmeasured: err.files.length,
    };
  }
  if (err instanceof CorpusMissingError) {
    return { status: 422, errorCode: "corpus_missing", error: `A source document this record lists is no longer in storage. ${NO_PARTIAL}` };
  }
  return modelErrorReply(err, fallback);
}

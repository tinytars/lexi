// One typed error and ONE sentence per failure mode, shared by every Anthropic-backed Translate.
//
// The relay already classifies properly (insufficient_credit / ai_busy / anthropic_error / ...), but
// the client used to read res.text() and concatenate the raw JSON into a message, and the caller then
// flattened that to .message — so errorCode was destroyed twice and credit exhaustion could not
// render the way it does elsewhere. Three renderers each hand-rolled their own wording on top of that.

export class AiError extends Error {
  errorCode?: string;
  status?: number;
  constructor(message: string, opts: { errorCode?: string; status?: number } = {}) {
    super(message);
    this.name = "AiError";
    this.errorCode = opts.errorCode;
    this.status = opts.status;
  }
}

const MESSAGES: Record<string, string> = {
  insufficient_credit: "AI is temporarily unavailable: the account is out of credits.",
  ai_busy: "The AI is busy right now — try again in a moment.",
  anthropic_error: "The AI service returned an error — try again in a moment.",
  no_tool_use: "The AI did not return a usable answer — try again.",
  invalid_leaf_regen: "The AI's answer did not fit the expected shape — try again.",
  truncated: "The AI's answer was cut off before it finished — try translating fewer rows at once.",
  timeout: "The AI took too long to answer and the request was stopped — try again.",
  offline: "Couldn't reach the AI service — check your connection and try again.",
  invalid_inference: "The AI couldn't read this product — try clearer photos, or paste the text instead.",
  no_input: "Add a photo or some text first.",
  text_too_long: "That text is too long — paste just the product's own description.",
  too_many_images: "Too many photos — 4 at most.",
};

/**
 * The user-facing sentence for a failure. Falls back to the thrown message (and finally to a generic
 * line) so an unclassified failure still says something rather than rendering blank or as raw JSON.
 */
export function describeAiError(err: unknown): string {
  const code = err instanceof AiError ? err.errorCode : undefined;
  if (code && MESSAGES[code]) return MESSAGES[code];
  const status = err instanceof AiError ? err.status : undefined;
  if (status === 402) return MESSAGES.insufficient_credit;
  if (status === 503) return MESSAGES.ai_busy;
  const message = err instanceof Error ? err.message.trim() : String(err ?? "").trim();
  // A JSON body that leaked through is noise, not a sentence — never show it to a patient.
  if (!message || message.startsWith("{")) return "Couldn't translate — try again in a moment.";
  return message;
}

export function aiErrorCode(err: unknown): string | undefined {
  return err instanceof AiError ? err.errorCode : undefined;
}

/**
 * Races a promise-producing call against a deadline, aborting it rather than leaving it pending.
 * `run` receives the signal so the underlying fetch is actually cancelled, not merely ignored.
 */
export async function withDeadline<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) throw new DOMException("cancelled", "AbortError");
    outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  try {
    return await run(ctrl.signal);
  } catch (e) {
    // An abort we caused on the deadline is a timeout; an abort the CALLER caused stays an abort, so
    // switching patients mid-Translate doesn't render as a red "took too long".
    if (timedOut) throw new AiError("timed out", { errorCode: "timeout" });
    throw e;
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }
}

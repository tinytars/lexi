import { describe, it, expect, vi, afterEach } from "vitest";
import { AiError, aiErrorCode, aiErrorCodeForStatus, describeAiError, withDeadline } from "../../src/lib/ai-error";

afterEach(() => vi.useRealTimers());

describe("describeAiError", () => {
  // The whole point of the typed error: the relay's errorCode, not the thrown message, decides the
  // wording — so credit exhaustion reads identically wherever it is rendered.
  it.each([
    ["insufficient_credit", "out of credits"],
    ["ai_busy", "busy right now"],
    ["model_error", "returned an error"],
    ["model_unsupported", "kind of input"],
    ["no_tool_use", "usable answer"],
    ["invalid_leaf_regen", "expected shape"],
    ["truncated", "cut off"],
    ["timeout", "too long"],
    ["offline", "check your connection"],
  ])("has a sentence for %s", (code, fragment) => {
    expect(describeAiError(new AiError("raw", { errorCode: code }))).toContain(fragment);
  });

  it("falls back to the status when the body carried no code", () => {
    expect(describeAiError(new AiError("x", { status: 402 }))).toContain("out of credits");
    expect(describeAiError(new AiError("x", { status: 503 }))).toContain("busy");
  });

  it("never renders a raw JSON body — the bug that showed patients relay internals", () => {
    const leaked = new Error('{"error":"leaf-regen backend error","errorCode":"model_error"}');
    expect(describeAiError(leaked)).not.toContain("{");
    expect(describeAiError(leaked)).toContain("Couldn't translate");
  });

  it("keeps an ordinary message when there is nothing better", () => {
    expect(describeAiError(new Error("no LEAF_REGEN_SPECS entry"))).toBe("no LEAF_REGEN_SPECS entry");
    expect(describeAiError(undefined)).toContain("Couldn't translate");
  });

  it("exposes the code for callers that branch on it", () => {
    expect(aiErrorCode(new AiError("x", { errorCode: "ai_busy" }))).toBe("ai_busy");
    expect(aiErrorCode(new Error("x"))).toBeUndefined();
  });
});

describe("aiErrorCodeForStatus", () => {
  it("classifies the two statuses that mean something on their own", () => {
    expect(aiErrorCodeForStatus(402)).toBe("insufficient_credit");
    expect(aiErrorCodeForStatus(503)).toBe("ai_busy");
  });

  // Deliberately undefined rather than "model_error": a caller that knows nothing more than the
  // status must keep falling through to whatever message it has, not be handed a sentence this map
  // happens to own. describeAiError depends on that — see "keeps an ordinary message" above.
  it.each([400, 401, 404, 413, 422, 500, 502, 504])("leaves %d unclassified", (status) => {
    expect(aiErrorCodeForStatus(status)).toBeUndefined();
  });

  // The failure this was written for. Cloudflare answers `error code: 1102` as text/plain when the
  // isolate is killed for exceeding its memory, so /api/chat returns 503 with no JSON body at all:
  // res.json() throws, the caller is left holding {}, and before this the patient was shown
  // "request failed (503)" for a condition whose entire answer is to send the message again.
  it("gives a body-less 503 the busy sentence a patient can act on", () => {
    const body: { error?: string; errorCode?: string } = {};
    const code = body.errorCode ?? aiErrorCodeForStatus(503) ?? "model_error";
    const text = describeAiError(new AiError(body.error ?? "", { errorCode: code, status: 503 }));
    expect(code).toBe("ai_busy");
    expect(text).toContain("busy right now");
    expect(text).not.toContain("503");
  });

  // A route that DOES classify itself keeps its own code, so the billing link stays reachable:
  // ChatTab renders it off error.code === "insufficient_credit".
  it("yields to a code the body carried", () => {
    const body = { errorCode: "insufficient_credit" };
    const code = body.errorCode ?? aiErrorCodeForStatus(503) ?? "model_error";
    expect(code).toBe("insufficient_credit");
    expect(describeAiError(new AiError("", { errorCode: code, status: 503 }))).toContain("out of credits");
  });

  // An unclassified status with a sentence of its own in the body shows that sentence rather than a
  // generic — 413 "conversation too large" is the real case.
  it("keeps the server's own sentence for a status it cannot classify", () => {
    const body = { error: "conversation too large", errorCode: "too_large" };
    const code = body.errorCode ?? aiErrorCodeForStatus(413) ?? "model_error";
    expect(describeAiError(new AiError(body.error, { errorCode: code, status: 413 }))).toBe("conversation too large");
  });
});

describe("withDeadline", () => {
  it("returns the value when the call finishes in time", async () => {
    await expect(withDeadline(50, async () => "ok")).resolves.toBe("ok");
  });

  // The actual reported bug: a call that never settles must stop and say why, not hang forever.
  it("aborts a hanging call and reports a timeout", async () => {
    let seen: AbortSignal | undefined;
    const p = withDeadline(10, (signal) => {
      seen = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    await expect(p).rejects.toMatchObject({ errorCode: "timeout" });
    expect(seen!.aborted).toBe(true);
  });

  // A caller-driven abort (switching patients mid-Translate) must stay an abort, so it is not
  // rendered to the user as a red "took too long".
  it("passes an outer abort through unchanged", async () => {
    const ctrl = new AbortController();
    const p = withDeadline(10_000, (signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      ctrl.signal,
    );
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses immediately when the outer signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const run = vi.fn();
    await expect(withDeadline(10, run, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
  });
});

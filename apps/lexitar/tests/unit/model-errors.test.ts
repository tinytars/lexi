import { describe, it, expect } from "vitest";
import { classifyModelError, modelErrorReply, ModelHttpError, ModelUnsupportedError } from "../../functions/_lib/model-errors";

// Pins every route's failure → (status, errorCode) contract. The browser branches on errorCode to
// show the billing link, so a misclassification here silently hides the recovery path.
describe("classifyModelError", () => {
  it("maps an Anthropic 400 credit-balance error to insufficient_credit (402)", () => {
    const err = { status: 400, type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing." };
    expect(classifyModelError(err)).toEqual({ status: 402, errorCode: "insufficient_credit" });
  });

  it("maps a 403 billing_error to insufficient_credit (402)", () => {
    expect(classifyModelError({ status: 403, type: "billing_error", message: "billing" }))
      .toEqual({ status: 402, errorCode: "insufficient_credit" });
  });

  it("reads the type off a nested error object", () => {
    expect(classifyModelError({ status: 403, error: { type: "billing_error" } }))
      .toEqual({ status: 402, errorCode: "insufficient_credit" });
  });

  // OpenAI signals an empty balance as a 429, which must not read as "busy, retry".
  it("maps OpenAI's 429 insufficient_quota to insufficient_credit, not ai_busy", () => {
    expect(classifyModelError(new ModelHttpError(429, "You exceeded your current quota", "insufficient_quota", "insufficient_quota")))
      .toEqual({ status: 402, errorCode: "insufficient_credit" });
  });

  it("maps rate-limit (429), unavailable (503) and overloaded (529) to ai_busy (503)", () => {
    expect(classifyModelError({ status: 429, type: "rate_limit_error" })).toEqual({ status: 503, errorCode: "ai_busy" });
    expect(classifyModelError(new ModelHttpError(503, "loading model"))).toEqual({ status: 503, errorCode: "ai_busy" });
    expect(classifyModelError({ status: 529, type: "overloaded_error" })).toEqual({ status: 503, errorCode: "ai_busy" });
  });

  it("maps a capability the configured model lacks to model_unsupported (422)", () => {
    expect(classifyModelError(new ModelUnsupportedError("PDF input"))).toEqual({ status: 422, errorCode: "model_unsupported" });
  });

  it("does not treat a generic 400 (no credit message) as a billing error", () => {
    expect(classifyModelError({ status: 400, type: "invalid_request_error", message: "messages: roles must alternate" }))
      .toEqual({ status: 502, errorCode: "model_error" });
  });

  it("falls back to model_error (502) for server errors, unknown, and non-error values", () => {
    expect(classifyModelError({ status: 500, type: "api_error" })).toEqual({ status: 502, errorCode: "model_error" });
    expect(classifyModelError(new Error("network down"))).toEqual({ status: 502, errorCode: "model_error" });
    expect(classifyModelError("boom")).toEqual({ status: 502, errorCode: "model_error" });
    expect(classifyModelError(null)).toEqual({ status: 502, errorCode: "model_error" });
  });
});

describe("modelErrorReply", () => {
  it("uses the route's own wording for a generic failure", () => {
    expect(modelErrorReply(new Error("x"), "chat backend error")).toEqual({ status: 502, errorCode: "model_error", error: "chat backend error" });
  });

  it("uses the shared sentence for a classified failure", () => {
    expect(modelErrorReply({ status: 402 }, "chat backend error").error).toContain("out of credits");
    expect(modelErrorReply(new ModelUnsupportedError("images"), "x").error).toContain("can't read this kind of input");
  });
});

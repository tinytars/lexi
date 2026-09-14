import { describe, it, expect } from "vitest";
import { classifyAnthropicError } from "../../functions/_lib/anthropic-errors";

// Pins the chat Function's failure → (status, errorCode) contract. The browser
// (ChatPanel.svelte) branches on errorCode to show the billing link, so a
// misclassification here silently hides the W7f recovery path.
describe("classifyAnthropicError", () => {
  it("maps a 400 credit-balance error to insufficient_credit (402)", () => {
    const err = { status: 400, type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing." };
    expect(classifyAnthropicError(err)).toEqual({ status: 402, errorCode: "insufficient_credit" });
  });

  it("maps a 403 billing_error to insufficient_credit (402)", () => {
    expect(classifyAnthropicError({ status: 403, type: "billing_error", message: "billing" }))
      .toEqual({ status: 402, errorCode: "insufficient_credit" });
  });

  it("reads the type off a nested error object", () => {
    expect(classifyAnthropicError({ status: 403, error: { type: "billing_error" } }))
      .toEqual({ status: 402, errorCode: "insufficient_credit" });
  });

  it("maps rate-limit (429) and overloaded (529) to ai_busy (503)", () => {
    expect(classifyAnthropicError({ status: 429, type: "rate_limit_error" }))
      .toEqual({ status: 503, errorCode: "ai_busy" });
    expect(classifyAnthropicError({ status: 529, type: "overloaded_error" }))
      .toEqual({ status: 503, errorCode: "ai_busy" });
  });

  it("does not treat a generic 400 (no credit message) as a billing error", () => {
    expect(classifyAnthropicError({ status: 400, type: "invalid_request_error", message: "messages: roles must alternate" }))
      .toEqual({ status: 502, errorCode: "anthropic_error" });
  });

  it("falls back to anthropic_error (502) for server errors, unknown, and non-error values", () => {
    expect(classifyAnthropicError({ status: 500, type: "api_error" })).toEqual({ status: 502, errorCode: "anthropic_error" });
    expect(classifyAnthropicError(new Error("network down"))).toEqual({ status: 502, errorCode: "anthropic_error" });
    expect(classifyAnthropicError("boom")).toEqual({ status: 502, errorCode: "anthropic_error" });
    expect(classifyAnthropicError(null)).toEqual({ status: 502, errorCode: "anthropic_error" });
  });
});

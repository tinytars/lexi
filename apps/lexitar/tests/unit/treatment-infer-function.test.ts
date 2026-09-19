import { fakeSessionDb } from "../support/session-db";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK so the gate, the limits and the error mapping are exercised with no billable call.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: createMock }; } }));

import { onRequestPost } from "../../functions/api/treatment-infer";
import { signSession } from "../../functions/_lib/session";
import { MAX_TREATMENT_TEXT_CHARS, TREATMENT_IMAGE_MODEL, TREATMENT_TEXT_MODEL } from "../../src/lib/treatment-infer-config";

const ENV = { ANTHROPIC_API_KEY: "k", SESSION_SECRET: "test-secret", DB: fakeSessionDb() };

function ok(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
}

async function post(body: unknown, withSession = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (withSession) headers.cookie = `hd_session=${await signSession(ENV, "acct-1")}`;
  const request = new Request("https://x/api/treatment-infer", { method: "POST", headers, body: JSON.stringify(body) });
  return onRequestPost({ request, env: ENV } as never);
}

const IMG = { base64: "AAAA", mediaType: "image/jpeg" };

beforeEach(() => { createMock.mockReset(); });

describe("/api/treatment-infer gate and limits", () => {
  it("401s without a session", async () => {
    expect((await post({ text: "x" }, false)).status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("400s when neither photos nor text are sent", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("no_input");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("400s on text past the cap, without paying for the call", async () => {
    const res = await post({ text: "x".repeat(MAX_TREATMENT_TEXT_CHARS + 1) });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("text_too_long");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("400s on more than 4 photos", async () => {
    const res = await post({ images: Array(5).fill(IMG) });
    expect((await res.json()).errorCode).toBe("too_many_images");
  });

  it("400s on malformed images, distinguishing that from sending none", async () => {
    expect((await (await post({ images: [{ base64: "", mediaType: "image/gif" }] })).json()).errorCode).toBe("no_images");
  });
});

describe("/api/treatment-infer model routing", () => {
  // Photos are vision work; text that is already text is not, and this is the common path.
  it("uses the vision model for photos and the cheaper one for text", async () => {
    createMock.mockResolvedValue(ok({ name: "A", kind: "drug" }));
    await post({ images: [IMG] });
    expect(createMock.mock.calls.at(-1)![0].model).toBe(TREATMENT_IMAGE_MODEL);
    await post({ text: "Thyroid Support" });
    expect(createMock.mock.calls.at(-1)![0].model).toBe(TREATMENT_TEXT_MODEL);
  });

  it("returns the normalized record, unsafe links already stripped", async () => {
    createMock.mockResolvedValue(ok({
      name: "Thyroid Support", kind: "supplement",
      ingredients: [{ name: "Selenium", amount: 100, unit: "mcg" }],
      links: [{ label: "COA", url: "https://a.com/c" }, { label: "bad", url: "javascript:alert(1)" }],
    }));
    const body = await (await post({ text: "sheet" })).json();
    expect(body.ingredients).toHaveLength(1);
    expect(body.links).toEqual([{ label: "COA", url: "https://a.com/c" }]);
  });
});

describe("/api/treatment-infer error mapping", () => {
  // A model-shaped failure is the model's fault (422), a transport/credit failure is not.
  it("422s when the model returns unparseable output", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "not json" }], stop_reason: "end_turn", usage: {} });
    const res = await post({ text: "sheet" });
    expect(res.status).toBe(422);
    expect((await res.json()).errorCode).toBe("invalid_inference");
  });

  it("422s when the answer is truncated rather than silently half-filling", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "{" }], stop_reason: "max_tokens", usage: {} });
    expect((await post({ text: "sheet" })).status).toBe(422);
  });

  it("maps credit exhaustion to 402 with the shared errorCode", async () => {
    // A plain rejection value, not an Error instance — matching chat-function.test.ts. An Error is
    // tracked by Node's unhandled-rejection diagnostics and vitest then fails the test on it even
    // though the Function caught it and every assertion passes.
    createMock.mockRejectedValue({ status: 400, message: "Your credit balance is too low to access the Anthropic API." });
    const res = await post({ text: "sheet" });
    expect((await res.json()).errorCode).toBe("insufficient_credit");
    expect(res.status).toBe(402);
  });
});

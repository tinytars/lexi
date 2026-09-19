import { describe, it, expect, vi, beforeEach } from "vitest";
import { runLeafRegen } from "../../src/lib/leaf-regen-anthropic";
import { LEAF_REGEN_MAX_TOKENS } from "../../src/lib/leaf-regen-config";
import { modelId } from "../../src/lib/model-config";

// runLeafRegen is the extracted core the Function test already exercises indirectly; these tests
// cover the outcome kinds
// (empty/no_tool_use/invalid/ok) directly, which the HTTP-wrapper tests don't isolate.
const createMock = vi.fn();
// runLeafRegen streams (LEAF_REGEN_MAX_TOKENS is only requestable that way), but it still reads one
// final message — so the fake stays a plain resolved response and createMock keeps receiving the same
// params object the assertions below inspect.
const llm = {
  client: { messages: { stream: (...args: unknown[]) => ({ finalMessage: () => createMock(...args) }) } } as never,
  model: modelId("leafRegen"),
};

function toolResponse(input: unknown, name = "emit_study_results") {
  return {
    content: [{ type: "tool_use", name, input }],
    usage: { input_tokens: 3, output_tokens: 4 },
    stop_reason: "tool_use",
  };
}

// W67 — the retry made call COUNTS meaningful (one attempt vs two), and they are only meaningful if
// the mock starts clean. Before this every test used mockResolvedValueOnce, so leakage never showed.
beforeEach(() => createMock.mockReset());

describe("runLeafRegen", () => {
  it("returns kind 'empty' without calling Anthropic when the node's context is empty", async () => {
    const result = await runLeafRegen({ ...llm, node: "studyResults", inputs: { pursuedStudy: { entries: [] } } });
    expect(result).toEqual({ kind: "empty" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns kind 'ok' with the validated result and usage on a valid tool call", async () => {
    createMock.mockResolvedValueOnce(toolResponse({ items: [{ study: "x", result: "y", group: "g" }] }));
    const result = await runLeafRegen({
      ...llm, node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } },
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.result).toEqual({ items: [{ study: "x", result: "y", group: "g" }] });
      expect(result.usage).toEqual({ input: 3, output: 4 });
    }
  });

  it("returns kind 'no_tool_use' when the model emits no tool_use block", async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: "text", text: "oops" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const result = await runLeafRegen({
      ...llm, node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } },
    });
    expect(result.kind).toBe("no_tool_use");
  });

  // W75 — before this, max_tokens surfaced as a SHAPE failure on the half-written tool call, and the
  // single retry was spent re-sending a request that truncates in exactly the same place: two billed
  // calls and an error about the wrong thing. One call, and the error names the real cause.
  it("returns kind 'truncated' on stop_reason max_tokens, without spending the retry", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "tool_use", name: "emit_study_results", input: { items: [] } }],
      usage: { input_tokens: 3, output_tokens: 4 },
      stop_reason: "max_tokens",
    });
    const result = await runLeafRegen({
      ...llm, node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } },
    });
    expect(result.kind).toBe("truncated");
    expect(createMock).toHaveBeenCalledTimes(1);
    if (result.kind === "truncated") expect(result.usage).toEqual({ input: 3, output: 4 });
  });

  it("returns kind 'invalid' with debug info when BOTH attempts fail validate", async () => {
    createMock.mockResolvedValue(toolResponse({ items: "not-an-array" }));
    const result = await runLeafRegen({
      ...llm, node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } },
    });
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.error.message).toMatch(/items missing or not an array/);
      expect(result.debug.stopReason).toBe("tool_use");
      // Both attempts are billed, so both must be reported — a retry missing from the cost line is
      // the same mistake the core's loop made for a whole milestone. Exact sums, not ">0": the
      // second attempt's tokens have to be ADDED, not overwrite the first's.
      expect(result.usage).toEqual({ input: 6, output: 8 });
    }
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  // W67 — the point of the retry. The id/coverage checks are strict, and without this a leaf that
  // tripped one lost its whole section for the run: the orchestrator records and moves on, so the only
  // recovery was a human clicking Translate.
  it("retries ONCE with the rejection fed back, and keeps a good second answer", async () => {
    const good = { items: [{ study: "x", result: "y", group: "g" }] };
    createMock.mockResolvedValueOnce(toolResponse({ items: "not-an-array" })).mockResolvedValueOnce(toolResponse(good));
    const result = await runLeafRegen({
      ...llm, node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } },
    });
    expect(result.kind).toBe("ok");
    expect(createMock).toHaveBeenCalledTimes(2);
    const retry = createMock.mock.calls[1]![0];
    const sent = typeof retry.messages[0].content === "string" ? retry.messages[0].content : JSON.stringify(retry.messages[0].content);
    expect(sent).toContain("CORRECTION");
    expect(sent).toContain("items missing or not an array");
  });

  it("does not retry when the model ignored the tool entirely — there is nothing to correct", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "no tool" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" });
    const result = await runLeafRegen({ ...llm, node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } } });
    expect(result.kind).toBe("no_tool_use");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("throws for an unknown node", async () => {
    await expect(runLeafRegen({ ...llm, node: "notANode", inputs: {} })).rejects.toThrow(/no LEAF_REGEN_SPECS entry/);
  });

  // The ceiling is the reason this call streams at all: at 8192 a whole-section regen came back
  // stop_reason="max_tokens" as a half-written tool call, and the SDK refuses a NON-streaming
  // request whose max_tokens implies a >10-minute generation.
  it("requests the configured ceiling, scoped or not", async () => {
    const inputs = { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } };
    createMock.mockResolvedValueOnce(toolResponse({ items: [{ study: "x", result: "y", group: "g" }] }));
    await runLeafRegen({ ...llm, node: "studyResults", inputs });
    expect(createMock.mock.calls.at(-1)![0].max_tokens).toBe(LEAF_REGEN_MAX_TOKENS);

    createMock.mockResolvedValueOnce(toolResponse({ items: [{ study: "x", result: "y", group: "g" }] }));
    await runLeafRegen({ ...llm, node: "studyResults", inputs, targetLabels: ["x"] });
    expect(createMock.mock.calls.at(-1)![0].max_tokens).toBe(LEAF_REGEN_MAX_TOKENS);
  });

  // A browser that disconnects must stop the generation, not leave the model producing tokens
  // nobody will read — the Function passes request.signal down for exactly this.
  it("forwards an abort signal to the SDK", async () => {
    const ctrl = new AbortController();
    createMock.mockResolvedValueOnce(toolResponse({ items: [{ study: "x", result: "y", group: "g" }] }));
    await runLeafRegen({
      ...llm, node: "studyResults",
      inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } },
      signal: ctrl.signal,
    });
    expect(createMock.mock.calls.at(-1)![1]).toEqual({ signal: ctrl.signal });
  });
});

describe("runLeafRegen attachments", () => {
  const inputs = { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } };
  const okResponse = () => toolResponse({ items: [{ study: "x", result: "y", group: "g" }] });

  it("folds an attached document's text into the message, alongside the JSON inputs", async () => {
    createMock.mockResolvedValueOnce(okResponse());
    await runLeafRegen({ ...llm, node: "studyResults", inputs, documents: [{ name: "trial.pdf", text: "LDL fell 40%" }] });
    const content = createMock.mock.calls.at(-1)![0].messages[0].content;
    expect(content).toContain("BEGIN DOCUMENT: trial.pdf");
    expect(content).toContain("LDL fell 40%");
    // The inputs are still there — the document is added to the turn, not substituted for it.
    expect(content).toContain("pursuedStudy");
  });

  it("sends documents as TEXT, never as document blocks — they were transcribed once already", async () => {
    createMock.mockResolvedValueOnce(okResponse());
    await runLeafRegen({ ...llm, node: "studyResults", inputs, documents: [{ name: "a.pdf", text: "t" }] });
    const content = createMock.mock.calls.at(-1)![0].messages[0].content;
    expect(typeof content).toBe("string");
  });

  it("leaves the message byte-identical when there are no documents", async () => {
    createMock.mockResolvedValueOnce(okResponse());
    await runLeafRegen({ ...llm, node: "studyResults", inputs });
    expect(createMock.mock.calls.at(-1)![0].messages[0].content).toBe(JSON.stringify(inputs));
  });

  it("drops an image whose media type the API cannot accept instead of sending it", async () => {
    // The HEIC gotcha (attachment-store.ts): compression is skipped and the original media type
    // survives. This used to be an unchecked cast, so the request went out and came back as an
    // opaque API error rather than the photo simply being left out.
    createMock.mockResolvedValueOnce(okResponse());
    await runLeafRegen({
      ...llm, node: "studyResults", inputs,
      images: [{ mediaType: "image/heic", base64: "AAA" }, { mediaType: "image/png", base64: "BBB" }],
    });
    const content = createMock.mock.calls.at(-1)![0].messages[0].content;
    const images = content.filter((b: { type: string }) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0].source.media_type).toBe("image/png");
  });

  it("falls back to a plain-string message when every image was unusable", async () => {
    createMock.mockResolvedValueOnce(okResponse());
    await runLeafRegen({ ...llm, node: "studyResults", inputs, images: [{ mediaType: "image/heic", base64: "AAA" }] });
    expect(typeof createMock.mock.calls.at(-1)![0].messages[0].content).toBe("string");
  });
});

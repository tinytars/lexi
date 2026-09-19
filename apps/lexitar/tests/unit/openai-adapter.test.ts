import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { openAIClient } from "../../functions/_lib/inference/openai";
import { ModelHttpError, ModelUnsupportedError, classifyModelError } from "../../functions/_lib/model-errors";
import type { OpenAIProvider } from "../../src/lib/model-config";
import { startFakeOpenAI, type FakeOpenAI } from "../fixtures/fake-openai";

let fake: FakeOpenAI;
beforeAll(async () => (fake = await startFakeOpenAI()));
afterAll(() => fake.close());

const ALL = { vision: true, pdf: true, jsonSchema: true, tools: true };
function provider(over: Partial<OpenAIProvider> = {}): OpenAIProvider {
  return { api: "openai", baseUrl: fake.baseUrl, keyEnv: [], caps: ALL, ...over };
}
function lastBody() {
  return fake.requests.at(-1)!.body;
}
function completion(message: object, finish_reason = "stop") {
  return { json: { id: "c1", model: "m-served", choices: [{ message, finish_reason }], usage: { prompt_tokens: 11, completion_tokens: 7 } } };
}

describe("openAIClient.messages.create", () => {
  it("sends the key as a Bearer header only when one is set", async () => {
    fake.reply(completion({ content: "hi" }));
    await openAIClient(provider(), "sk-test").messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] });
    expect(fake.requests.at(-1)!.authorization).toBe("Bearer sk-test");
    expect(fake.requests.at(-1)!.path).toBe("/v1/chat/completions");

    fake.reply(completion({ content: "hi" }));
    await openAIClient(provider(), undefined).messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] });
    expect(fake.requests.at(-1)!.authorization).toBeUndefined();
  });

  it("translates system, a tool round trip, images and PDFs into Chat Completions messages", async () => {
    fake.reply(completion({ content: "done" }));
    await openAIClient(provider(), undefined).messages.create({
      model: "gpt-x",
      max_tokens: 100,
      system: [{ type: "text", text: "be brief" }],
      messages: [
        { role: "user", content: "readings?" },
        { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "t1", name: "get", input: { marker: "ApoB" } }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "80 mg/dL" }] },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "PDF" }, title: "lab.pdf" },
            { type: "document", source: { type: "text", media_type: "text/plain", data: "plain doc" } },
          ],
        },
      ],
    });
    expect(lastBody().messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "readings?" },
      { role: "assistant", content: "checking", tool_calls: [{ id: "t1", type: "function", function: { name: "get", arguments: '{"marker":"ApoB"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "80 mg/dL" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          { type: "file", file: { filename: "lab.pdf", file_data: "data:application/pdf;base64,PDF" } },
          { type: "text", text: "plain doc" },
        ],
      },
    ]);
    expect(lastBody().max_completion_tokens).toBe(100);
  });

  it("maps tools, a forced tool_choice, JSON schema output and the token field", async () => {
    fake.reply(completion({ content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "emit", arguments: '{"a":1}' } }] }, "stop"));
    const msg = await openAIClient(provider({ maxTokensField: "max_tokens", maxOutputTokens: 50 }), undefined).messages.create({
      model: "m",
      max_tokens: 4096,
      tools: [{ name: "emit", description: "emit it", input_schema: { type: "object", properties: { a: { type: "number" } } } }],
      tool_choice: { type: "tool", name: "emit" },
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
      messages: [{ role: "user", content: "go" }],
    });
    const body = lastBody();
    expect(body.tools).toEqual([{ type: "function", function: { name: "emit", description: "emit it", parameters: { type: "object", properties: { a: { type: "number" } } } } }]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "emit" } });
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "output", schema: { type: "object" }, strict: false } });
    expect(body.max_tokens).toBe(50);
    expect(body.max_completion_tokens).toBeUndefined();
    // A forced call finishes "stop" with the call attached; the call is what the core reads.
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content).toEqual([{ type: "tool_use", id: "c9", name: "emit", input: { a: 1 } }]);
  });

  it.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["content_filter", "refusal"],
  ])("maps finish_reason %s to stop_reason %s, with usage", async (finish, stop) => {
    fake.reply(completion({ content: "t" }, finish));
    const msg = await openAIClient(provider(), undefined).messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] });
    expect(msg.stop_reason).toBe(stop);
    expect(msg.usage.input_tokens).toBe(11);
    expect(msg.usage.output_tokens).toBe(7);
    expect(msg.content).toEqual([{ type: "text", text: "t", citations: null }]);
  });

  it.each([
    ["images", { vision: false }, { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } }],
    ["PDF documents", { pdf: false }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "P" } }],
  ])("refuses %s on a model without the capability, before sending anything", async (what, caps, block) => {
    const before = fake.requests.length;
    const call = openAIClient(provider({ caps: { ...ALL, ...caps } }), undefined).messages.create({
      model: "m",
      max_tokens: 5,
      messages: [{ role: "user", content: [block as Anthropic.ContentBlockParam] }],
    });
    await expect(call).rejects.toBeInstanceOf(ModelUnsupportedError);
    await expect(call).rejects.toThrow(what);
    expect(fake.requests.length).toBe(before);
  });

  it("refuses tools and JSON schema output on a model that lacks them", async () => {
    const noTools = openAIClient(provider({ caps: { ...ALL, tools: false } }), undefined);
    await expect(
      noTools.messages.create({ model: "m", max_tokens: 5, tools: [{ name: "t", input_schema: { type: "object" } }], messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("tools");
    const noJson = openAIClient(provider({ caps: { ...ALL, jsonSchema: false } }), undefined);
    await expect(
      noJson.messages.create({ model: "m", max_tokens: 5, output_config: { format: { type: "json_schema", schema: {} } }, messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("structured JSON output");
  });

  it("surfaces an HTTP error with the fields classifyModelError reads", async () => {
    fake.reply({ status: 429, json: { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } } });
    const err = await openAIClient(provider(), "k")
      .messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelHttpError);
    expect(classifyModelError(err)).toEqual({ status: 402, errorCode: "insufficient_credit" });
  });
});

describe("openAIClient.messages.stream", () => {
  const chunks = [
    { id: "s1", model: "m-served", choices: [{ delta: { content: "Hel" } }] },
    { id: "s1", choices: [{ delta: { content: "lo" } }] },
    { id: "s1", choices: [{ delta: { tool_calls: [{ index: 0, id: "tc", function: { name: "emit", arguments: '{"a"' } }] } }] },
    { id: "s1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":2}" } }] }, finish_reason: "tool_calls" }] },
    { id: "s1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
  ];

  it("emits Anthropic stream events and reassembles the final message", async () => {
    fake.reply({ sse: chunks });
    const stream = openAIClient(provider(), undefined).messages.stream({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] });
    const deltas: string[] = [];
    const types: string[] = [];
    for await (const ev of stream) {
      types.push(ev.type);
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") deltas.push(ev.delta.text);
    }
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(types[0]).toBe("message_start");
    expect(types.at(-1)).toBe("message_stop");
    expect(lastBody().stream).toBe(true);
    expect(lastBody().stream_options).toEqual({ include_usage: true });
    const final = await stream.finalMessage();
    expect(final.content).toEqual([
      { type: "text", text: "Hello", citations: null },
      { type: "tool_use", id: "tc", name: "emit", input: { a: 2 } },
    ]);
    expect(final.stop_reason).toBe("tool_use");
    expect(final.usage.output_tokens).toBe(4);
  });

  it("finalMessage drains an unread stream on its own", async () => {
    fake.reply({ sse: chunks.slice(0, 2) });
    const final = await openAIClient(provider(), undefined).messages.stream({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] }).finalMessage();
    expect(final.content).toEqual([{ type: "text", text: "Hello", citations: null }]);
    expect(final.stop_reason).toBe("end_turn");
  });

  it("rejects an unsupported input at the call, before any request", () => {
    const before = fake.requests.length;
    const client = openAIClient(provider({ caps: { ...ALL, vision: false } }), undefined);
    expect(() =>
      client.messages.stream({ model: "m", max_tokens: 5, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A" } }] }] }),
    ).toThrow(ModelUnsupportedError);
    expect(fake.requests.length).toBe(before);
  });

  it("rejects finalMessage with the server's error", async () => {
    fake.reply({ status: 503, json: { error: { message: "model loading" } } });
    const err = await openAIClient(provider(), undefined)
      .messages.stream({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] })
      .finalMessage()
      .catch((e: unknown) => e);
    expect(classifyModelError(err)).toEqual({ status: 503, errorCode: "ai_busy" });
  });
});

// The Messages port spoken over an OpenAI-compatible /chat/completions endpoint (OpenAI, Ollama,
// vLLM, LM Studio: only the base URL differs). Call cores keep building Anthropic-shaped requests;
// this translates them out and the replies back, so nothing above it knows which provider ran.
// Dropped on the way out: cache_control (OpenAI caches prompts on its own) and thinking.
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient, MessagesStream } from "@pablotech/akesi/model-client";
import type { OpenAIProvider } from "../../../src/lib/model-config";
import { ModelHttpError, ModelUnsupportedError } from "../model-errors";

type Json = Record<string, unknown>;
type RequestBody = Anthropic.MessageCreateParamsNonStreaming | Anthropic.MessageStreamParams;

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatChoice {
  message?: { content?: string | null; tool_calls?: ChatToolCall[]; refusal?: string | null };
  finish_reason?: string | null;
}

interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function requireCap(provider: OpenAIProvider, cap: keyof OpenAIProvider["caps"], what: string): void {
  if (!provider.caps[cap]) throw new ModelUnsupportedError(what);
}

function systemText(system: RequestBody["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

function toolResultText(content: Anthropic.ToolResultBlockParam["content"]): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

function userParts(blocks: Anthropic.ContentBlockParam[], provider: OpenAIProvider): Json[] {
  const parts: Json[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      requireCap(provider, "vision", "images");
      const url = b.source.type === "base64" ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.type === "url" ? b.source.url : undefined;
      if (!url) throw new ModelUnsupportedError(`${b.source.type} image sources`);
      parts.push({ type: "image_url", image_url: { url } });
    } else if (b.type === "document") {
      if (b.source.type === "text") {
        parts.push({ type: "text", text: b.source.data });
      } else if (b.source.type === "base64") {
        requireCap(provider, "pdf", "PDF documents");
        parts.push({ type: "file", file: { filename: b.title ?? "document.pdf", file_data: `data:${b.source.media_type};base64,${b.source.data}` } });
      } else {
        throw new ModelUnsupportedError(`${b.source.type} document sources`);
      }
    }
  }
  return parts;
}

function toChatMessages(body: RequestBody, provider: OpenAIProvider): Json[] {
  const out: Json[] = [];
  const system = systemText(body.system);
  if (system) out.push({ role: "system", content: system });
  for (const m of body.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const toolCalls = m.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }] : [],
      );
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    // Chat Completions wants each tool result as its own message, straight after the assistant turn
    // that called it; any text riding alongside follows as a normal user message.
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolResultText(b.content) });
    }
    const parts = userParts(m.content, provider);
    if (parts.length) out.push({ role: "user", content: parts });
  }
  return out;
}

function toolChoice(choice: Anthropic.ToolChoice | undefined): unknown {
  switch (choice?.type) {
    case undefined:
      return undefined;
    case "tool":
      return { type: "function", function: { name: choice.name } };
    case "any":
      return "required";
    case "none":
      return "none";
    default:
      return "auto";
  }
}

export function toChatRequest(body: RequestBody, provider: OpenAIProvider, stream: boolean): Json {
  const req: Json = { model: body.model, messages: toChatMessages(body, provider) };
  const maxTokens = provider.maxOutputTokens ? Math.min(body.max_tokens, provider.maxOutputTokens) : body.max_tokens;
  req[provider.maxTokensField ?? "max_completion_tokens"] = maxTokens;
  if (body.tools?.length) {
    requireCap(provider, "tools", "tools");
    req.tools = body.tools.map((t) => {
      if (!("input_schema" in t)) throw new ModelUnsupportedError(`the ${t.type} server tool`);
      return { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } };
    });
    const choice = toolChoice(body.tool_choice);
    if (choice !== undefined) req.tool_choice = choice;
  }
  const format = body.output_config?.format;
  if (format?.type === "json_schema") {
    requireCap(provider, "jsonSchema", "structured JSON output");
    req.response_format = { type: "json_schema", json_schema: { name: "output", schema: format.schema, strict: false } };
  }
  if (body.temperature !== undefined) req.temperature = body.temperature;
  if (body.top_p !== undefined) req.top_p = body.top_p;
  if (body.stop_sequences?.length) req.stop = body.stop_sequences;
  if (stream) {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }
  return req;
}

function stopReason(finish: string | null | undefined, hasToolCalls: boolean): Anthropic.StopReason {
  if (finish === "length") return "max_tokens";
  // A forced tool_choice finishes "stop" with tool calls attached; the calls are what matters.
  if (hasToolCalls || finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "content_filter") return "refusal";
  return "end_turn";
}

function parseArguments(args: string, name: string): unknown {
  try {
    return args ? JSON.parse(args) : {};
  } catch {
    throw new ModelHttpError(502, `the model returned malformed arguments for tool ${name}`);
  }
}

export function toMessage(completion: ChatCompletion, requestedModel: string): Anthropic.Message {
  const choice = completion.choices?.[0];
  const text = choice?.message?.content ?? choice?.message?.refusal ?? "";
  const toolCalls = choice?.message?.tool_calls ?? [];
  const content: Json[] = [];
  if (text) content.push({ type: "text", text, citations: null });
  for (const c of toolCalls) content.push({ type: "tool_use", id: c.id, name: c.function.name, input: parseArguments(c.function.arguments, c.function.name) });
  return {
    id: completion.id ?? "",
    type: "message",
    role: "assistant",
    model: completion.model ?? requestedModel,
    content,
    stop_reason: stopReason(choice?.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message;
}

async function errorFrom(res: Response): Promise<ModelHttpError> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string; type?: string; code?: string } } | null;
  return new ModelHttpError(res.status, body?.error?.message ?? `model server returned ${res.status}`, body?.error?.type, body?.error?.code);
}

// Yields each SSE `data:` payload; stops at [DONE].
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield data;
    }
  }
}

interface StreamChunk {
  id?: string;
  model?: string;
  choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; type?: string; code?: string };
}

class ChatCompletionStream implements MessagesStream {
  private started = false;
  private readonly settled: Promise<Anthropic.Message>;
  private resolve!: (m: Anthropic.Message) => void;
  private reject!: (e: unknown) => void;
  private readonly open: () => Promise<Response>;
  private readonly model: string;

  constructor(open: () => Promise<Response>, model: string) {
    this.open = open;
    this.model = model;
    this.settled = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    this.settled.catch(() => {});
  }

  [Symbol.asyncIterator](): AsyncIterator<Anthropic.RawMessageStreamEvent> {
    if (this.started) throw new Error("a model stream can be read once");
    this.started = true;
    return this.run();
  }

  async finalMessage(): Promise<Anthropic.Message> {
    if (!this.started) for await (const _ of this) void _;
    return this.settled;
  }

  private async *run(): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
    try {
      const res = await this.open();
      if (!res.ok || !res.body) throw await errorFrom(res);
      let text = "";
      let finish: string | null | undefined;
      let usage: StreamChunk["usage"];
      let id: string | undefined;
      let model: string | undefined;
      const calls: { id: string; name: string; arguments: string }[] = [];
      yield { type: "message_start", message: toMessage({ model: this.model }, this.model) } as Anthropic.RawMessageStreamEvent;
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } } as Anthropic.RawMessageStreamEvent;
      for await (const data of sseData(res.body)) {
        const chunk = JSON.parse(data) as StreamChunk;
        if (chunk.error) throw new ModelHttpError(502, chunk.error.message ?? "model stream failed", chunk.error.type, chunk.error.code);
        id ??= chunk.id;
        model ??= chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta?.content;
        if (delta) {
          text += delta;
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } } as Anthropic.RawMessageStreamEvent;
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          const call = (calls[tc.index] ??= { id: "", name: "", arguments: "" });
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (tc.function?.arguments) call.arguments += tc.function.arguments;
        }
      }
      yield { type: "content_block_stop", index: 0 } as Anthropic.RawMessageStreamEvent;
      const message = toMessage(
        {
          id,
          model,
          usage: usage ?? undefined,
          choices: [
            {
              finish_reason: finish,
              message: { content: text, tool_calls: calls.filter(Boolean).map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
            },
          ],
        },
        this.model,
      );
      yield { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage } as unknown as Anthropic.RawMessageStreamEvent;
      yield { type: "message_stop" } as Anthropic.RawMessageStreamEvent;
      this.resolve(message);
    } catch (e) {
      this.reject(e);
      throw e;
    }
  }
}

export function openAIClient(provider: OpenAIProvider, apiKey: string | undefined): MessagesClient {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const post = (payload: Json, signal?: AbortSignal) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(payload),
      signal,
    });
  return {
    messages: {
      async create(body, options) {
        const res = await post(toChatRequest(body, provider, false), options?.signal);
        if (!res.ok) throw await errorFrom(res);
        return toMessage((await res.json()) as ChatCompletion, body.model);
      },
      stream(body, options) {
        // Translate eagerly so an unsupported input fails at the call, before any bytes are spent.
        const payload = toChatRequest(body, provider, true);
        return new ChatCompletionStream(() => post(payload, options?.signal), body.model);
      },
    },
  };
}

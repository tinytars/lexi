import type { D1Database } from "../_lib/identity-types";
import Anthropic from "@anthropic-ai/sdk";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { json } from "../_lib/http";
import { classifyAnthropicError } from "../_lib/anthropic-errors";
import { CHAT_MODEL } from "../../src/lib/chat-config";
import { KODI_ADAPTER_PROMPT } from "../../src/lib/persona-adapter-prompt";
import { missingFacts } from "../../src/lib/persona-fidelity";

// W84 — restates one finished Lexi answer in Kodi's voice. Stateless relay like /api/chat: the answer
// text is PHI, so it is never logged or stored here. When the restatement cannot be trusted to carry
// every fact, the reply is `fallback` and the browser shows Lexi's own words instead.
interface Env {
  ANTHROPIC_API_KEY: string;
  SESSION_SECRET: string;
  DB: D1Database;
}

const ROUTE = "/api/persona-adapt";
const MAX_TEXT = 32 * 1024;
const ATTEMPTS = 2;

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const start = Date.now();
  const finish = (status: number, payload: unknown, errorCode?: string) => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });
    return json(status, payload);
  };

  const session = await requireSession(request, env);
  if (session instanceof Response) return finish(401, { error: "unauthorized" }, "unauthorized");

  const body = (await request.json().catch(() => null)) as { persona?: unknown; text?: unknown } | null;
  if (body?.persona !== "kodi") return finish(400, { error: "unknown persona" }, "bad_persona");
  if (typeof body.text !== "string" || !body.text.trim()) return finish(400, { error: "text is required" }, "no_text");
  if (body.text.length > MAX_TEXT) return finish(413, { error: "answer too long to adapt" }, "too_large");
  const source = body.text;

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    let missing: string[] = [];
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const reminder = missing.length
        ? `\n\nYour previous restatement dropped or changed these facts; every one must appear exactly as written: ${missing.join(", ")}`
        : "";
      const message = await client.messages.create({
        model: CHAT_MODEL,
        max_tokens: 4096,
        system: KODI_ADAPTER_PROMPT,
        messages: [{ role: "user", content: `LEXI'S ANSWER:\n${source}${reminder}` }],
      });
      if (message.stop_reason === "max_tokens") break;
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (!text) break;
      missing = missingFacts(source, text);
      if (missing.length === 0) return finish(200, { kind: "adapted", persona: "kodi", text });
    }
    return finish(200, { kind: "fallback" }, "fidelity");
  } catch (err) {
    const { status, errorCode } = classifyAnthropicError(err);
    return finish(status, { error: "could not restate the answer", errorCode }, errorCode);
  }
}

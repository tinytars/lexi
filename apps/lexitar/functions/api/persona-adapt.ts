import Anthropic from "@anthropic-ai/sdk";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { json } from "../_lib/http";
import { inferenceErrorReply } from "../_lib/model-errors";
import { attachedModelFor, type AttachedEnv } from "../_lib/inference/attach";
import { subjectOf } from "../_lib/inference/subject";
import { CODY_ADAPTER_PROMPT, adapterMessage } from "../../src/lib/persona-adapter-prompt";
import { readPersonaId } from "../../src/lib/personas";
import { missingFacts } from "../../src/lib/persona-fidelity";

// W84 — restates one finished Lexi answer in Cody's voice. The answer and the patient's question are
// PHI, so neither is logged or stored here. When the restatement cannot be trusted to carry every
// fact, the reply is `fallback` and the browser shows Lexi's own words instead.
//
// The reports are attached here too (CORPUS.md), which is the one route where that is close to pure
// cost: a restatement changes the voice of a paragraph that already contains every fact, and
// `missingFacts` below is what proves it. It is attached anyway because the alternative is a
// per-feature switch, and a per-feature switch is how one inference quietly ends up knowing less
// than the rest. Measure it, then decide — the plan's §8, not a judgement made in this file.
interface Env extends AttachedEnv {
  SESSION_SECRET: string;
}

const ROUTE = "/api/persona-adapt";
const MAX_TEXT = 32 * 1024;
const MAX_QUESTION = 8 * 1024;
const ATTEMPTS = 2;

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const start = Date.now();
  const finish = (status: number, payload: unknown, errorCode?: string) => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });
    return json(status, payload);
  };

  const session = await requireSession(request, env);
  if (session instanceof Response) return finish(401, { error: "unauthorized" }, "unauthorized");

  const body = (await request.json().catch(() => null)) as { persona?: unknown; text?: unknown; question?: unknown; clientId?: unknown } | null;
  const { text: source, question } = body ?? {};
  if (readPersonaId(body?.persona) !== "cody") return finish(400, { error: "unknown persona" }, "bad_persona");
  if (typeof source !== "string" || !source.trim()) return finish(400, { error: "text is required" }, "no_text");
  if (question !== undefined && typeof question !== "string") return finish(400, { error: "question must be text" }, "bad_question");
  if (source.length > MAX_TEXT || (question?.length ?? 0) > MAX_QUESTION) return finish(413, { error: "answer too long to adapt" }, "too_large");

  const who = subjectOf(session, body ?? {});
  if ("error" in who) return finish(who.status, { error: who.error, errorCode: who.errorCode }, who.errorCode);

  try {
    const { client, model, corpus } = await attachedModelFor(env, "persona", who);
    let missing: string[] = [];
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const reminder = missing.length
        ? `\n\nYour previous restatement dropped or changed these facts; every one must appear exactly as written: ${missing.join(", ")}`
        : "";
      const message = await client.messages.create({
        model,
        max_tokens: 4096,
        system: CODY_ADAPTER_PROMPT,
        messages: [...corpus.turns, { role: "user", content: adapterMessage(source, question) + reminder }],
      });
      if (message.stop_reason === "max_tokens") break;
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (!text) break;
      missing = missingFacts(source, text);
      if (missing.length === 0) return finish(200, { kind: "adapted", persona: "cody", text });
    }
    return finish(200, { kind: "fallback" }, "fidelity");
  } catch (err) {
    // A corpus refusal carries its own sentence — "this record holds 312 pages" is not "could not
    // restate the answer", and the browser shows it rather than silently falling back.
    const { status, errorCode, error, ...extra } = inferenceErrorReply(err, "could not restate the answer");
    return finish(status, { error, errorCode, ...extra }, errorCode);
  }
}

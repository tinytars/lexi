import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { inferenceErrorReply } from "../_lib/model-errors";
import { attachedModelFor, type AttachedEnv } from "../_lib/inference/attach";
import { GET_MARKER_READINGS_TOOL } from "../../src/lib/chat-tools";
import { chatSystemPrompt } from "../../src/lib/chat-prompt";
import { providerFor } from "../../src/lib/model-config";

// Reads a patient's reports into the prompt cache before they ask anything, so their first question
// is answered against a warm entry instead of waiting out a ~270K-token cache write (CORPUS.md).
//
// `max_tokens: 0` is the platform's own pre-warm: the API reads the prompt, writes the cache at the
// breakpoint, and returns an empty `content` with zero output tokens billed. The write itself is
// billed — this moves that cost earlier, it does not remove it — which is why this route exists for
// ONE feature rather than all of them:
//
//   * `ranges` and `markerGroups` set `output_config.format`, which `max_tokens: 0` rejects. They
//     get the same effect for free instead, by letting one call land before the rest fan out
//     (range-fill.ts).
//   * `leafRegen` sends a different tool schema and system prompt per node, and the cache prefix
//     renders tools -> system -> messages, so each node's corpus is a separate entry. Pre-warming
//     the sweep would mean buying every one of those writes up front for a sweep that may never run.
//   * `persona` and `treatmentText` restate text that already holds every fact; warming them spends
//     a write on a question nobody asked.
//
// Chat is the one place the patient waits at a cursor, and its prefix is stable: one system prompt
// per unit system, one tool. So this route warms chat and says so in its name's absence — see the
// `feature` const below, which is where a second feature would have to argue for itself.
interface Env extends AttachedEnv {
  SESSION_SECRET: string;
}

const ROUTE = "/api/corpus-warm";
const FEATURE = "chat" as const;

// Anything with non-whitespace content; never answered, and outside the cached prefix because the
// breakpoint sits on the last document block.
const PLACEHOLDER = "warmup";

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const requestId = request.headers.get("cf-ray") ?? undefined;

  const finish = (status: number, payload: unknown, extra: Partial<Parameters<typeof logRequest>[0]> = {}): Response => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, requestId, ...extra });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };

  const session = await requireSession(request, env);
  if (session instanceof Response) return finish(401, { error: "unauthorized" }, { errorCode: "unauthorized" });

  let body: { clientId?: unknown; unitSystem?: unknown };
  try {
    body = await request.json();
  } catch {
    return finish(400, { error: "malformed JSON body" }, { errorCode: "bad_json" });
  }
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!clientId) return finish(400, { error: "clientId is required", errorCode: "no_client_id" }, { errorCode: "no_client_id" });

  // Pre-warming is an Anthropic-side optimization. An OpenAI-compatible provider has no equivalent
  // and would reject the zero budget, so it is skipped rather than translated — the corpus itself
  // stays portable, this is the layer on top of it that does not have to be.
  if (providerFor(FEATURE).api !== "anthropic") return finish(200, { warmed: false, reason: "unsupported" });

  try {
    const { client, model, corpus } = await attachedModelFor(env, FEATURE, { accountId: session.accountId, clientId });
    // Nothing to warm: REPORTS is off, or this record holds no PDFs yet. Either way a cache entry
    // over a bare system prompt is not worth a round trip.
    if (corpus.turns.length === 0) return finish(200, { warmed: false, reason: "no_corpus" });

    const message = await client.messages.create({
      model,
      max_tokens: 0,
      // Byte-identical to what /api/chat sends, or this writes an entry chat never reads.
      system: chatSystemPrompt(body.unitSystem === "metric" ? "metric" : "imperial"),
      tools: [GET_MARKER_READINGS_TOOL],
      messages: [...corpus.turns, { role: "user", content: PLACEHOLDER }],
    });
    const u = message.usage as { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    return finish(200, { warmed: true, written: u.cache_creation_input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0 },
      { usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } });
  } catch (err) {
    const { status, ...payload } = inferenceErrorReply(err, "corpus warm failed");
    return finish(status, payload, { errorCode: payload.errorCode });
  }
}

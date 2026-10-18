import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { inferenceErrorReply } from "../_lib/model-errors";
import { withAttachedModel, type AttachedEnv } from "../_lib/inference/attach";
import { parseRawKeys } from "../../src/lib/raw-cipher";
import { GET_MARKER_READINGS_TOOL } from "../../src/lib/chat-tools";
import { chatSystemPrompt } from "../../src/lib/chat-prompt";
import { reportsAttached } from "../_lib/inference/corpus";
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
//   * `finding` is refreshed in the background rather than at a cursor, so there is no wait to move
//     earlier — and it bills to its own key pool, which pre-warming would drain on nobody's behalf.
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

  let body: { clientId?: unknown; unitSystem?: unknown; rawKeys?: unknown };
  try {
    body = await request.json();
  } catch {
    return finish(400, { error: "malformed JSON body" }, { errorCode: "bad_json" });
  }
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!clientId) return finish(400, { error: "clientId is required", errorCode: "no_client_id" }, { errorCode: "no_client_id" });

  // Answered before anything else, and separately from "this record holds no PDFs", because the
  // browser reads this one field to decide whether a PDF attachment still needs its transcription
  // sent as text: with the corpus on it is already in the request as a document block, with the
  // corpus off that transcription is the only copy there is (CORPUS.md).
  if (!reportsAttached(env)) return finish(200, { warmed: false, reason: "off" });

  // Pre-warming is an Anthropic-side optimization. An OpenAI-compatible provider has no equivalent
  // and would reject the zero budget, so it is skipped rather than translated — the corpus itself
  // stays portable, this is the layer on top of it that does not have to be.
  if (providerFor(FEATURE).api !== "anthropic") return finish(200, { warmed: false, reason: "unsupported" });

  try {
    return await withAttachedModel(env, FEATURE, { accountId: session.accountId, clientId, rawKeys: parseRawKeys(body) }, async ({ client, model, corpus }) => {
      // Nothing to warm: this record holds no PDFs yet. A cache entry over a bare system prompt is
      // not worth a round trip.
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
    });
  } catch (err) {
    const { status, ...payload } = inferenceErrorReply(err, "corpus warm failed");
    // A 5xx here answers 200, like the three `warmed: false` refusals above it. A pre-warm is
    // fire-and-forget — the browser reads `warmed` and nothing else, and a cold cache is a slower
    // first answer, never a wrong one. Answering 5xx made every busy provider a red request in the
    // console and a candidate for the browser's own 5xx reporter, for an outcome the app is built
    // to tolerate. A 4xx keeps its status: "this record is not yours" and "this model cannot take
    // PDFs" are verdicts on the CALLER, not on the moment, and softening those would hide them.
    if (status < 500) return finish(status, payload, { errorCode: payload.errorCode });
    // `reason: "failed"` and not the errorCode itself: the browser reads `reason` to learn whether
    // this DEPLOYMENT attaches reports, and a failed attempt is a verdict on the moment, not on the
    // deployment. Naming it apart from "off"/"unsupported"/"no_corpus" is what keeps an attached
    // PDF's transcription in the question when nothing else is carrying the document.
    return finish(200, { warmed: false, reason: "failed", errorCode: payload.errorCode }, { errorCode: payload.errorCode });
  }
}

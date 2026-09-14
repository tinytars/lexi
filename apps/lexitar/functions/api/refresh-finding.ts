import Anthropic from "@anthropic-ai/sdk";
import { requireBearer } from "../_lib/guard";
import { logRequest } from "../_lib/log";
import { auditor } from "../_lib/audit";
import { buildUserMessage, SYSTEM_PROMPT, correctionSuffix } from "@pablotech/akesi-pil/finding-generate";
import { FINDING_MODEL } from "../../src/lib/finding-config";
import { findingRequestParams } from "@pablotech/akesi-pil/finding-generate";

// W15/3b.2 — provider-only web Finding refresh. Gated on PROVIDER_TOKEN (the distinct secret from
// /api/provider-token). A Finding call runs minutes, so we STREAM Opus text to the browser
// headers-first (validated no-524 by the 3b.2 probe): the browser accumulates → extractJson →
// validate → assembleFinding → merge → PUT /api/vault. Retry-with-correction is browser-driven (it
// re-POSTs with `correction`). Runs on a DISTINCT FINDING_ANTHROPIC_API_KEY (a Finding-pool key,
// separate from the chat/extract key). PHI-free logging (id/status only, never the client or prose).
interface R2Bucket {
  put(key: string, value: string, options?: unknown): Promise<unknown>;
}
interface Env {
  FINDING_ANTHROPIC_API_KEY: string;
  PROVIDER_TOKEN: string;
  // W39/Phase 3 — persist the PHI-free audit trail to R2. Optional so a test/local env without the
  // binding degrades to console-only logging.
  VAULT?: R2Bucket;
  STORE_PREFIX: string;
}

const ROUTE = "/api/refresh-finding";
const MAX_BODY_BYTES = 4 * 1024 * 1024; // a decrypted client is well under this

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const requestId = request.headers.get("cf-ray") ?? undefined;
  const jsonErr = (status: number, errorCode: string, error: string): Response => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, requestId, errorCode });
    return new Response(JSON.stringify({ error, errorCode }), { status, headers: { "content-type": "application/json" } });
  };

  // Bearer is checked BEFORE we commit to a 200 stream — an unauthorized caller gets a real 401.
  if (requireBearer(request, env.PROVIDER_TOKEN)) return jsonErr(401, "unauthorized", "unauthorized");

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return jsonErr(413, "too_large", "client too large");
  let body: { client?: unknown; correction?: unknown; corrections?: unknown; attempt?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonErr(400, "bad_json", "malformed JSON body");
  }
  const client = body.client;
  if (!client || typeof client !== "object") return jsonErr(400, "no_client", "client is required");
  // `corrections` is the accumulated list; `correction` is the pre-W72 singular field, still accepted
  // so a browser that has not reloaded keeps working rather than losing its retry ladder entirely.
  const corrections = Array.isArray(body.corrections)
    ? body.corrections.filter((c): c is string => typeof c === "string" && c.length > 0)
    : typeof body.correction === "string" && body.correction
      ? [body.correction]
      : [];
  const attempt = typeof body.attempt === "number" ? body.attempt : undefined;

  const anthropic = new Anthropic({ apiKey: env.FINDING_ANTHROPIC_API_KEY });
  // W72 — one definition, in finding-generate.ts, and it takes EVERY prior rejection rather than the
  // latest. This route used to carry its own singular "fix exactly this problem" wording: the exact
  // behaviour W67 measured burning six full Opus generations on one refresh, fixed in the CLI at the
  // time and left live on the browser path, which is the one patients use.
  const userContent = buildUserMessage(client as never) + correctionSuffix(corrections);
  const model = FINDING_MODEL;
  // W64 — one definition, in finding-generate.ts. Both the adaptive-thinking heuristic and the
  // token budget were restated here verbatim; a change to either had to be made twice or the web
  // Finding stopped matching the CLI Finding, which is the invariant finding-config.ts guards.
  const requestParams = findingRequestParams(model);

  // Committing to a 200 stream. Audit the accepted request now (PHI-free, persisted to R2); once
  // headers are sent an Anthropic/credit failure can only be signalled IN-BAND (the [[REFRESH_ERROR]]
  // sentinel below). The auditor is bound to this request (seq per event → one R2 object per event).
  const audit = auditor(env.VAULT, env, ROUTE, requestId);
  await audit({ event: "accepted", status: 200, latencyMs: Date.now() - start, attempt });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let chars = 0;
      try {
        const s = anthropic.messages.stream(
          {
            model,
            ...requestParams,
            system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: userContent }],
          },
          // W39: when the browser cancels (or disconnects), abort the upstream Anthropic request so
          // the model stops generating tokens — otherwise a cancelled refresh keeps spending.
          { signal: request.signal },
        );
        for await (const event of s) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            chars += event.delta.text.length;
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        const final = await s.finalMessage(); // surfaces a terminal stream error (e.g. overloaded) into the catch
        // W39: record the real cost of this generation (PHI-free — token counts + a char size, never text).
        await audit({
          event: "stream-done",
          status: 200,
          latencyMs: Date.now() - start,
          attempt,
          chars,
          usage: { input: final.usage.input_tokens, output: final.usage.output_tokens },
        });
      } catch (e) {
        // A browser cancel/disconnect aborts request.signal → the SDK throws. Record it as an abort
        // (the generation stopped spending), distinct from a genuine post-header stream failure.
        const aborted = request.signal.aborted;
        if (!aborted) {
          controller.enqueue(encoder.encode(`\n[[REFRESH_ERROR]] ${(e as Error).message ?? "generation failed"}`));
        }
        await audit({
          event: aborted ? "aborted" : "error",
          status: 200,
          latencyMs: Date.now() - start,
          attempt,
          chars,
          errorCode: aborted ? "aborted" : "generation_failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

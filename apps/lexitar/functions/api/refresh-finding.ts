import { requireBearer } from "../_lib/guard";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { auditor } from "../_lib/audit";
import { inferenceErrorReply } from "../_lib/model-errors";
import { buildUserMessage, SYSTEM_PROMPT, correctionSuffix } from "@pablotech/akesi/finding-generate";
import { attachedModelFor, type AttachedEnv } from "../_lib/inference/attach";
import { subjectOf } from "../_lib/inference/subject";
import { findingRequestParams } from "@pablotech/akesi/finding-generate";
import type { ObjectBucket } from "../_lib/object-bucket";

// W15/3b.2 — provider-only web Finding refresh. Gated on PROVIDER_TOKEN (the distinct secret from
// /api/provider-token). A Finding call runs minutes, so we STREAM Opus text to the browser
// headers-first (validated no-524 by the 3b.2 probe): the browser accumulates → extractJson →
// validate → assembleFinding → merge → PUT /api/vault. Retry-with-correction is browser-driven (it
// re-POSTs with `correction`). Runs on the Finding-pool key (the "finding" feature in
// inference.config.json, separate from the chat/extract key). PHI-free logging (id/status only, never the client or prose).
//
// The Finding is now generated in sight of the person's own reports (CORPUS.md), which is what adds
// DB and promotes VAULT from optional: the audit trail could degrade to console-only without a
// binding, but a corpus cannot degrade to "some of the record" — it either reads R2 or refuses.
interface Env extends AttachedEnv {
  PROVIDER_TOKEN: string;
  SESSION_SECRET: string;
  VAULT: Pick<ObjectBucket, "get" | "list" | "put">;
}

const ROUTE = "/api/refresh-finding";
const MAX_BODY_BYTES = 4 * 1024 * 1024; // a decrypted client is well under this

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const requestId = request.headers.get("cf-ray") ?? undefined;
  // `extra` carries a corpus refusal's limit/actual/max — the numbers ARE the remedy, so dropping
  // them would leave the browser saying "too large" with nothing the patient can act on.
  const jsonErr = (status: number, errorCode: string, error: string, extra: Record<string, unknown> = {}): Response => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, requestId, errorCode });
    return new Response(JSON.stringify({ error, errorCode, ...extra }), { status, headers: { "content-type": "application/json" } });
  };

  // Bearer is checked BEFORE we commit to a 200 stream — an unauthorized caller gets a real 401.
  //
  // Dual-auth now, matching /api/refresh-range: either credential admits, and the SESSION is tried
  // first because only it carries an account. PROVIDER_TOKEN is a deployment-wide secret; treating
  // it as permission to read any patient's plaintext PDFs would re-open the exact gap raw-owner.ts
  // closed, on the route that reads the most PHI of any in the app. So a bearer-only caller names
  // the account it acts for (subject.ts) and rawAccessFor still has to agree.
  const session = await requireSession(request, env);
  if (session instanceof Response && requireBearer(request, env.PROVIDER_TOKEN)) {
    return jsonErr(401, "unauthorized", "unauthorized");
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return jsonErr(413, "too_large", "client too large");
  let body: { client?: unknown; correction?: unknown; corrections?: unknown; attempt?: unknown; clientId?: unknown; accountId?: unknown };
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

  // Whose record this Finding is about. Required whatever REPORTS is set to, so turning the corpus
  // on in a deployment never changes the request contract underneath its callers.
  const who = subjectOf(session instanceof Response ? null : session, body);
  if ("error" in who) return jsonErr(who.status, who.errorCode, who.error);

  // W72 — one definition, in finding-generate.ts, and it takes EVERY prior rejection rather than the
  // latest. This route used to carry its own singular "fix exactly this problem" wording: the exact
  // behaviour W67 measured burning six full Opus generations on one refresh, fixed in the CLI at the
  // time and left live on the browser path, which is the one patients use.
  const userContent = buildUserMessage(client as never) + correctionSuffix(corrections);

  // Resolved BEFORE the 200 stream commits. Once headers are sent the only way to report a failure
  // is the in-band sentinel, which the browser reads as `generation_failed` and RETRIES — three
  // full Opus generations against a record that cannot be assembled either time. A record too large
  // to send is an HTTP status carrying the page numbers that say what to remove.
  let resolved: Awaited<ReturnType<typeof attachedModelFor>>;
  try {
    resolved = await attachedModelFor(env, "finding", who);
  } catch (e) {
    const { status, error, errorCode, ...rest } = inferenceErrorReply(e, "finding backend error");
    return jsonErr(status, errorCode, error, rest);
  }
  const { client: anthropic, model, corpus } = resolved;
  // W64 — one definition, in finding-generate.ts. Both the adaptive-thinking heuristic and the
  // token budget were restated here verbatim; a change to either had to be made twice or the web
  // Finding stopped matching the CLI Finding, which is the invariant inference.config.json keeps by giving both one entry.
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
            messages: [...corpus.turns, { role: "user", content: userContent }],
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

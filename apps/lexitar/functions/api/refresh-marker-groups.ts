import { requireBearer } from "../_lib/guard";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { auditor } from "../_lib/audit";
import { distinctMarkerNames, markerGroupsHashOf, runMarkerGroupingPasses } from "@pablotech/akesi/marker-groups-prompt";
import { runGroupingPass } from "../../src/lib/marker-groups-anthropic";
import { inferenceErrorReply } from "../_lib/model-errors";
import { attachedModelFor, type AttachedEnv } from "../_lib/inference/attach";
import { subjectOf } from "../_lib/inference/subject";
import { systemOrder } from "@pablotech/akesi/system-groups";
import type { Client, MarkerGrouping } from "../../src/lib/types";
import type { ObjectBucket } from "../_lib/object-bucket";

// M95 — web-triggered marker->body-system classification for zero-knowledge (self-service)
// accounts, which the CLI's --refresh-marker-groups can never reach (it only touches a local
// vault.json). Mirrors refresh-range.ts's dual-auth (provider bearer OR the patient's own
// session) so either party can trigger it from the browser, which already holds the decrypted
// vault. Unlike refresh-range, a full run is up to 4 sequential Opus calls (initial pass + up
// to 3 completeness re-passes, same shape as scripts/claude-marker-groups.ts), so this streams
// like refresh-finding.ts to avoid an idle-timeout 524 during a long generation. Runs on the
// shared key (on-demand, user-triggered — not worth a dedicated pooled key).
//
// AttachedEnv brings DB (which requireSession needs anyway, W71 — it reads
// accounts.sessions_valid_from) and STORE_PREFIX; VAULT is re-declared wider because the audit
// trail writes through the same binding the corpus reads from.
interface Env extends AttachedEnv {
  PROVIDER_TOKEN: string;
  SESSION_SECRET: string;
  VAULT: Pick<ObjectBucket, "get" | "list" | "put">;
}

const ROUTE = "/api/refresh-marker-groups";
const MAX_BODY_BYTES = 4 * 1024 * 1024; // a decrypted client is well under this
const SENTINEL = "[[REFRESH_ERROR]]";

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const requestId = request.headers.get("cf-ray") ?? undefined;
  // `extra` carries a corpus refusal's limit/actual/max — the numbers are the remedy.
  const jsonErr = (status: number, errorCode: string, error: string, extra: Record<string, unknown> = {}): Response => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, requestId, errorCode });
    return new Response(JSON.stringify({ error, errorCode, ...extra }), { status, headers: { "content-type": "application/json" } });
  };

  // Provider bearer, else a logged-in patient session (mirrors refresh-range.ts; the account owner
  // viewing their own vault has no provider token). The session is tried first because only it
  // carries the account the corpus is authorised against — see subject.ts.
  const session = await requireSession(request, env);
  if (session instanceof Response && requireBearer(request, env.PROVIDER_TOKEN)) {
    return jsonErr(401, "unauthorized", "unauthorized");
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return jsonErr(413, "too_large", "client too large");
  let body: { client?: unknown; clientId?: unknown; accountId?: unknown; rawKeys?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonErr(400, "bad_json", "malformed JSON body");
  }
  const client = body.client;
  if (!client || typeof client !== "object") return jsonErr(400, "no_client", "client is required");

  const typedClient = client as Client;
  const systems = systemOrder(typedClient);
  if (systems.length === 0) {
    return jsonErr(400, "no_finding", "no System Analysis yet — run a Finding refresh first");
  }
  const markerNames = distinctMarkerNames(typedClient);
  const hash = markerGroupsHashOf(markerNames, systems);

  // Required whatever REPORTS is set to, so enabling the corpus never changes the request contract.
  const who = subjectOf(session instanceof Response ? null : session, body);
  if ("error" in who) return jsonErr(who.status, who.errorCode, who.error);

  // Hash short-circuit, hoisted out of the stream: a grouping that already matches costs no model
  // call, and must therefore cost no report read either.
  const cached = typedClient.markerGroups?.markerGroupsHash === hash;

  // The model and the corpus are resolved BEFORE the 200 is committed to, which is the only moment
  // a refusal can still be an HTTP status rather than an in-band sentinel. A record too large to
  // send is not a generation failure, and the browser renders the two very differently.
  let resolved: Awaited<ReturnType<typeof attachedModelFor>> | undefined;
  if (!cached) {
    try {
      resolved = await attachedModelFor(env, "markerGroups", who);
    } catch (e) {
      const { status, errorCode, error, ...extra } = inferenceErrorReply(e, "marker grouping failed");
      return jsonErr(status, errorCode, error, extra);
    }
  }

  // Committing to a 200 stream (same convention as refresh-finding.ts) — once headers are sent,
  // a downstream failure can only be signalled in-band via the SENTINEL below.
  const audit = auditor(env.VAULT, env, ROUTE, requestId);
  await audit({ event: "accepted", status: 200, latencyMs: Date.now() - start });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Hash short-circuit: the current marker/system set already matches the client's stored
        // grouping — zero Anthropic calls, even for a duplicate/accidental trigger.
        if (cached) {
          await audit({ event: "success", status: 200, latencyMs: Date.now() - start, reasonCategory: "cached" });
          controller.enqueue(encoder.encode(JSON.stringify(typedClient.markerGroups)));
          return;
        }

        const { client: anthropic, model, corpus } = resolved!;
        let passes = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        // W64 — the call itself lives in src/lib/marker-groups-anthropic.ts, shared with the CLI.
        // What is genuinely this side's stays here: the AbortSignal, and the [[PASS]] progress
        // chunk the client streams.
        const callModel = async (markers: string[], leftover: boolean): Promise<{ group: string; markers: string[] }[]> =>
          runGroupingPass({
            anthropic,
            client: typedClient,
            markers,
            model,
            leftover,
            prefixTurns: corpus.turns,
            signal: request.signal,
            onPass: (u: { input_tokens?: number | null; output_tokens?: number | null }) => {
              inputTokens += u.input_tokens ?? 0;
              outputTokens += u.output_tokens ?? 0;
              passes++;
              controller.enqueue(encoder.encode(`[[PASS]] ${passes}\n`));
            },
          });

        const groups = await runMarkerGroupingPasses(typedClient, systems, callModel);
        if (groups.length === 0) throw new Error("marker grouping produced no groups");

        const grouping: MarkerGrouping = {
          groups,
          markerGroupsHash: hash,
          generatedAt: new Date().toISOString(),
          generatedBy: { mode: "prod", model },
        };
        await audit({
          event: "success",
          status: 200,
          latencyMs: Date.now() - start,
          usage: { input: inputTokens, output: outputTokens },
        });
        controller.enqueue(encoder.encode(JSON.stringify(grouping)));
      } catch (e) {
        // A browser cancel/disconnect aborts request.signal — record it as an abort, not an error.
        const aborted = request.signal.aborted;
        if (!aborted) {
          controller.enqueue(encoder.encode(`\n${SENTINEL} ${(e as Error).message ?? "generation failed"}`));
        }
        await audit({
          event: aborted ? "aborted" : "error",
          status: 200,
          latencyMs: Date.now() - start,
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

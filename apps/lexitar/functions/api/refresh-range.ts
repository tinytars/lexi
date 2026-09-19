import type { D1Database } from "../_lib/identity-types";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { requireBearer } from "../_lib/guard";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { auditor } from "../_lib/audit";
import { classifyAnthropicError } from "../_lib/anthropic-errors";
import { generateRange, NoMeasuredUnitError } from "../../src/lib/ranges-anthropic";
import { RANGES_MODEL } from "../../src/lib/ranges-config";
import { factorsCanonicalString } from "../../src/lib/factors-hash";
import type { Client, PersonalizedRange } from "../../src/lib/types";
import type { ObjectBucket } from "../_lib/object-bucket";

// M59/Phase 2 — provider-only web Ranges refresh for ONE marker at a time. Gated on PROVIDER_TOKEN
// (the same secret as /api/refresh-finding). Unlike Finding, a range is small and schema-constrained
// (max_tokens: 1024), so this responds with a single plain JSON PersonalizedRange — no streaming.
// Runs on a DISTINCT RANGES_ANTHROPIC_API_KEY (a Ranges-pool key, separate from Finding/chat/extract).
// PHI-free logging (id/status only, never the client or prose). Imports prompt/schema/validation
// from src/lib/ranges-prompt.ts (pure, mirrors report-extract.ts's split), never from
// scripts/claude-ranges.ts (its generateRange()/factorsHashOf pull in scripts/factors.ts →
// finding-dag.ts) — the factorsHash below is computed inline from factorsCanonicalString instead,
// keeping this endpoint's module graph isolated from the Finding/investigator-study inference graph.
interface Env {
  RANGES_ANTHROPIC_API_KEY: string;
  PROVIDER_TOKEN: string;
  SESSION_SECRET: string;
  // W71 — requireSession reads accounts.sessions_valid_from, so every gated route needs the binding.
  DB: D1Database;
  VAULT?: Pick<ObjectBucket, "put">;
  STORE_PREFIX: string;
}

const ROUTE = "/api/refresh-range";
const MAX_BODY_BYTES = 4 * 1024 * 1024; // a decrypted client is well under this

function hash12(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const requestId = request.headers.get("cf-ray") ?? undefined;
  const jsonErr = (status: number, errorCode: string, error: string): Response => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, requestId, errorCode });
    return new Response(JSON.stringify({ error, errorCode }), { status, headers: { "content-type": "application/json" } });
  };

  // Bearer is checked BEFORE we do any generation — provider bearer, else a logged-in patient
  // session (M60 auto-Translate-on-import calls this from the browser, no provider token).
  // Payload-scoped (client/marker in the body, not a route param), so no envelope-ownership
  // check is needed once the session itself verifies — mirrors vault/[id].ts:58-64.
  const denied = requireBearer(request, env.PROVIDER_TOKEN);
  if (denied) {
    const session = await requireSession(request, env);
    if (session instanceof Response) return jsonErr(401, "unauthorized", "unauthorized");
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return jsonErr(413, "too_large", "client too large");
  let body: { client?: unknown; marker?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonErr(400, "bad_json", "malformed JSON body");
  }
  const client = body.client;
  if (!client || typeof client !== "object") return jsonErr(400, "no_client", "client is required");
  const marker = typeof body.marker === "string" ? body.marker : "";
  if (!marker) return jsonErr(400, "no_marker", "marker is required");

  const typedClient = client as Client;

  const audit = auditor(env.VAULT, env, ROUTE, requestId);
  await audit({ event: "accepted", status: 200, latencyMs: Date.now() - start });

  try {
    // W64 — the prompt, the retry ladder, the dimensionless-ratio handling and the assembly all
    // live in src/lib/ranges-anthropic.ts now, shared with the CLI. What stays here is the HTTP
    // shell: auth, the body cap, the audit trail, the error→status mapping, and factorsHash (which
    // hashes through node:crypto here on purpose — see the module-graph note above).
    const usage = { input: 0, output: 0 };
    const range: PersonalizedRange = {
      ...(await generateRange({
        anthropic: new Anthropic({ apiKey: env.RANGES_ANTHROPIC_API_KEY }),
        marker,
        client: typedClient,
        model: RANGES_MODEL,
        mode: "prod",
        onUsage: (u: { input_tokens?: number | null; output_tokens?: number | null }) => {
          usage.input += u.input_tokens ?? 0;
          usage.output += u.output_tokens ?? 0;
        },
        isTransient: (err: unknown) => {
          const { status, errorCode } = classifyAnthropicError(err);
          return status === 503 && errorCode === "ai_busy";
        },
      })),
      factorsHash: hash12(factorsCanonicalString(typedClient)),
    };

    await audit({ event: "success", status: 200, latencyMs: Date.now() - start, usage });

    return new Response(JSON.stringify({ marker, range }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    // W64 — a marker with no readings still answers 400 no_unit, as it did when this check ran
    // inline before the call. Only the check MOVED (into the shared module, which is where the
    // dimensionless-ratio exemption it pairs with now lives); the contract did not.
    if (e instanceof NoMeasuredUnitError) {
      await audit({ event: "error", status: 400, latencyMs: Date.now() - start, errorCode: "no_unit" });
      return jsonErr(400, "no_unit", e.message);
    }
    await audit({ event: "error", status: 500, latencyMs: Date.now() - start, errorCode: "generation_failed" });
    return new Response(
      JSON.stringify({ error: (e as Error).message ?? "range generation failed", errorCode: "generation_failed" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

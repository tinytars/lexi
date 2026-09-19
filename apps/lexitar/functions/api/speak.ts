import type { D1Database } from "../_lib/identity-types";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { json } from "../_lib/http";
import { DEFAULT_PERSONA, PERSONAS, isPersonaId } from "../../src/lib/personas";

// W84 — neural read-aloud. A stateless relay to Azure AI Speech: the text is an answer about the
// patient (PHI), so it is never logged or stored here. The browser speaks one sentence-sized chunk
// per call and falls back to its own voice on any non-200.
interface Env {
  SESSION_SECRET: string;
  DB: D1Database;
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION?: string;
}

const ROUTE = "/api/speak";
const MAX_TEXT = 2000;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const start = Date.now();
  const fail = (status: number, error: string, errorCode: string) => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });
    return json(status, { error });
  };

  const session = await requireSession(request, env);
  if (session instanceof Response) return fail(401, "unauthorized", "unauthorized");

  const body = (await request.json().catch(() => null)) as { voice?: unknown; text?: unknown } | null;
  const persona = body?.voice ?? DEFAULT_PERSONA;
  if (!isPersonaId(persona)) return fail(400, "unknown voice", "bad_voice");
  if (typeof body?.text !== "string" || !body.text.trim()) return fail(400, "text is required", "no_text");
  if (body.text.length > MAX_TEXT) return fail(413, "text too long to speak", "too_large");
  if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) return fail(503, "speech is not configured", "not_configured");

  const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="${PERSONAS[persona].voice}">${xml(body.text)}</voice></speak>`;
  const res = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "lexitar",
    },
    body: ssml,
  });
  if (!res.ok) return fail(502, "speech backend error", `vendor_${res.status}`);

  logRequest({ route: ROUTE, status: 200, latencyMs: Date.now() - start });
  return new Response(res.body, { status: 200, headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}

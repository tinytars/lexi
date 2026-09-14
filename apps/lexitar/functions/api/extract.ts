import type { D1Database } from "../_lib/identity-types";
import Anthropic from "@anthropic-ai/sdk";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { classifyAnthropicError } from "../_lib/anthropic-errors";
import { proposeFromReport, type ReportPatient } from "@pablotech/akesi-pil/report-extract";
import { EXTRACT_MODEL } from "../../src/lib/extract-config";

// W15/1 — extract an uploaded clinical report server-side. The browser can't hold
// the Anthropic key, so it sends the raw PDF (base64) + a MINIMIZED patient subset
// here; this relay sends the PDF straight to Claude as a document block (no pdfjs on
// the Workers runtime) and returns the validated ProposedReport. The browser then
// folds it into the decrypted vault client-side — the vault plaintext and keys never
// transit; only the report itself does (a documented, bounded exposure). Runs on
// ANTHROPIC_API_KEY, distinct from the Finding key so it can't drain that credit pool.
interface Env {
  ANTHROPIC_API_KEY: string;
  SESSION_SECRET: string;
  // W71 — requireSession reads accounts.sessions_valid_from, so every gated route needs the binding.
  DB: D1Database;
}

const ROUTE = "/api/extract";
// A base64 PDF inflates ~33%; 24 MB of body admits an ~18 MB PDF (well past any
// clinical report, under Claude's 32 MB document ceiling).
const MAX_BODY_BYTES = 24 * 1024 * 1024;

// The browser's request shape. `patient` is the minimized subset systemPromptFor
// reads — never the whole vault.
interface ExtractBody {
  sourceFile?: unknown;
  pdfBase64?: unknown;
  patient?: unknown;
}

function validatePatient(raw: unknown): ReportPatient | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.dob !== "string" || (p.gender !== "male" && p.gender !== "female")) return null;
  // factors is optional; if present it must be an object (diseases array checked leniently).
  if (p.factors !== undefined && (typeof p.factors !== "object" || p.factors === null)) return null;
  return raw as ReportPatient;
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const requestId = request.headers.get("cf-ray") ?? undefined;

  const finish = (status: number, payload: unknown, extra: Partial<Parameters<typeof logRequest>[0]> = {}): Response => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, requestId, ...extra });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    return finish(401, { error: "unauthorized" }, { errorCode: "unauthorized" });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return finish(413, { error: "report too large", errorCode: "too_large" }, { errorCode: "too_large" });
  }
  let body: ExtractBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return finish(400, { error: "malformed JSON body", errorCode: "bad_json" }, { errorCode: "bad_json" });
  }

  const sourceFile = typeof body.sourceFile === "string" && body.sourceFile.trim() ? body.sourceFile : "report.pdf";
  if (typeof body.pdfBase64 !== "string" || body.pdfBase64.length === 0) {
    return finish(400, { error: "pdfBase64 is required", errorCode: "no_pdf" }, { errorCode: "no_pdf" });
  }
  const patient = validatePatient(body.patient);
  if (!patient) {
    return finish(400, { error: "patient (dob, gender) is required", errorCode: "no_patient" }, { errorCode: "no_patient" });
  }

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const today = new Date().toISOString().slice(0, 10);
    const report = await proposeFromReport(client, { pdfBase64: body.pdfBase64 }, sourceFile, patient, today, EXTRACT_MODEL);
    return finish(200, report);
  } catch (err) {
    // A schema/validation failure from proposeFromReport is the model's fault, not a
    // transport error — surface it as 422 so the browser shows "couldn't read this report".
    const message = (err as Error).message ?? "";
    // The import gate (report-extract.ts's validate): this document is readable but is not a
    // clinical report. Its own code and its own reason, so the UI can say WHY the import was
    // refused instead of the generic "couldn't read this" — the difference between a user who
    // knows to attach it to a note instead and one who just retries the same file.
    const notReport = /^report "[^"]*" is not a medical report: (.*)$/.exec(message);
    if (notReport) {
      const reason = notReport[1];
      return finish(422, { error: `This doesn't look like a medical report — ${reason}. Attach it to a note or a chat instead.`, errorCode: "not_a_report" }, { errorCode: "not_a_report" });
    }
    if (/^report "|^extraction truncated|^invalid JSON for|^no text block/.test(message)) {
      return finish(422, { error: "could not extract this report", detail: message, errorCode: "invalid_extraction" }, { errorCode: "invalid_extraction" });
    }
    const { status, errorCode } = classifyAnthropicError(err);
    const messagesByCode: Record<string, string> = {
      insufficient_credit: "AI is temporarily unavailable: the account is out of credits.",
      ai_busy: "The AI is busy right now — try again in a moment.",
      anthropic_error: "extraction backend error",
    };
    return finish(status, { error: messagesByCode[errorCode] ?? "extraction backend error", errorCode }, { errorCode });
  }
}

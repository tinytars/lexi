import type { D1Database } from "../_lib/identity-types";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { modelErrorReply } from "../_lib/model-errors";
import { modelFor } from "../_lib/inference/resolve";
import { proposeFromReport, type ReportPatient, type ReportSource } from "@pablotech/akesi/report-extract";
import { validatePageImages } from "../_lib/page-images";
import { detailFor, reportServerError, type ServerErrorEnv } from "../_lib/server-error";

// W15/1 — extract an uploaded clinical report server-side. The browser can't hold
// the Anthropic key, so it sends the raw PDF (base64) + a MINIMIZED patient subset
// here; this relay sends the PDF straight to Claude as a document block (no pdfjs on
// the Workers runtime) and returns the validated ProposedReport. The browser then
// folds it into the decrypted vault client-side — the vault plaintext and keys never
// transit; only the report itself does (a documented, bounded exposure). Runs on
// ANTHROPIC_API_KEY, distinct from the Finding key so it can't drain that credit pool.
interface Env extends ServerErrorEnv {
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
  // Rendered pages, when the configured model can see but cannot take a PDF (pdf-pages-for-model.ts).
  // The browser renders because the Workers runtime has no pdfjs.
  pageImages?: unknown;
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

export async function onRequestPost(context: {
  request: Request;
  env: Env;
  waitUntil: (p: Promise<unknown>) => void;
}): Promise<Response> {
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
  const pageImages = validatePageImages(body.pageImages);
  const source: ReportSource | null =
    pageImages ? { pageImages } : typeof body.pdfBase64 === "string" && body.pdfBase64.length > 0 ? { pdfBase64: body.pdfBase64 } : null;
  if (!source) {
    return finish(400, { error: "pdfBase64 or pageImages is required", errorCode: "no_pdf" }, { errorCode: "no_pdf" });
  }
  const patient = validatePatient(body.patient);
  if (!patient) {
    return finish(400, { error: "patient (dob, gender) is required", errorCode: "no_patient" }, { errorCode: "no_patient" });
  }

  try {
    const { client, model } = modelFor(env, "extract");
    const today = new Date().toISOString().slice(0, 10);
    const report = await proposeFromReport(client, source, sourceFile, patient, today, model);
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
      // The middleware files only what a handler failed to classify, and this one is classified — but
      // the classification is "our model answered with something that isn't a report", which is a
      // defect on our side and reaches nobody unless it is filed. The user sees "couldn't extract
      // this report" and moves on. code-only, because the message quotes the document.
      context.waitUntil(
        reportServerError(env, err, {
          route: ROUTE,
          method: request.method,
          deployment: new URL(request.url).host,
          requestId,
          detail: detailFor(ROUTE),
          status: 422,
          errorCode: "invalid_extraction",
        }),
      );
      return finish(422, { error: "could not extract this report", detail: message, errorCode: "invalid_extraction" }, { errorCode: "invalid_extraction" });
    }
    const { status, errorCode, error } = modelErrorReply(err, "extraction backend error");
    return finish(status, { error, errorCode }, { errorCode });
  }
}

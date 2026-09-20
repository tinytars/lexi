// W15/1 — browser side of report extraction. Base64-encodes the uploaded PDF and
// POSTs it (+ the minimized patient) to the stateless /api/extract relay, which
// returns the validated ProposedReport. Holds no passphrase and does no persistence;
// the caller folds the result into the decrypted vault and saves.
import type { PageImage, ProposedReport, ReportPatient } from "@pablotech/akesi/report-extract";
import { AiError } from "./ai-error";
import { bytesToBase64 } from "./base64";
import { needsPageImages, renderPdfPages } from "./pdf-pages-for-model";

// The report as the configured model can take it: natively when it reads PDFs, rendered to pages
// when it can only see. A model with neither cap gets the PDF and the relay's own 422 — the refusal
// is the server's to make, not the browser's to guess at.
async function documentBody(bytes: Uint8Array): Promise<{ pdfBase64: string } | { pageImages: PageImage[] }> {
  if (!needsPageImages("extract")) return { pdfBase64: bytesToBase64(bytes) };
  return { pageImages: await renderPdfPages(bytes) };
}

export async function extractReport(
  bytes: Uint8Array,
  sourceFile: string,
  patient: ReportPatient,
): Promise<ProposedReport> {
  // /api/extract is gated by the hd_session cookie (W44) — same-origin fetch sends it automatically.
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceFile, ...(await documentBody(bytes)), patient }),
  });
  if (!res.ok) {
    let payload: { error?: string; errorCode?: string } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    // AiError, not a bare Error: the code is what lets describeAiError render the one sentence
    // this failure mode already has (model_unsupported, insufficient_credit, …) rather than the
    // relay's raw text.
    throw new AiError(payload.error || `extraction failed (${res.status})`, {
      errorCode: payload.errorCode,
      status: res.status,
    });
  }
  return (await res.json()) as ProposedReport;
}

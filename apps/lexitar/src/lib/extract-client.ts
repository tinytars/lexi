// W15/1 — browser side of report extraction. Base64-encodes the uploaded PDF and
// POSTs it (+ the minimized patient) to the stateless /api/extract relay, which
// returns the validated ProposedReport. Holds no passphrase and does no persistence;
// the caller folds the result into the decrypted vault and saves.
import type { ProposedReport, ReportPatient } from "@pablotech/akesi/report-extract";
import { AiError } from "./ai-error";

// Chunked base64 — String.fromCharCode(...bytes) overflows the call stack on a
// multi-MB PDF, so encode in 32 KB windows.
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
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
    body: JSON.stringify({ sourceFile, pdfBase64: bytesToBase64(bytes), patient }),
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

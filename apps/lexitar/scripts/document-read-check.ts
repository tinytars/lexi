// Run ONE real PDF through the exact path /api/document-extract uses.
//
// PAID, and deliberately NOT in the gate: every run is an Opus document call (~$0.19 for a 2-page
// report — 6.9k input tokens, 1.1k output). It exists because the documents pipeline shipped
// against synthetic fixtures only; W65 closed that with the first real-PDF run and this is the
// harness, kept so re-verifying after a change to document-read.ts is one command rather than a
// rebuild of the setup.
//
// NOT a reimplementation of the Function: readDocument, the "document" model and the {pdfBase64} source
// shape are the Function's own, so a change there is exercised here.
//
//   npm run doc:read-check -- records/private/<client-id>/raw/<file>.pdf
//
// Reads only — nothing is written, no vault or sidecar is touched. The 15 PDFs under
// records/private/*/raw/ are real PHI; the transcription it prints is too, so keep the output local.
import "./load-creds";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readDocument } from "@pablotech/akesi/document-read";
import { modelFor } from "../functions/_lib/inference/resolve";

// Byte-identical to the Function's bytesToBase64 (chunked: a spread overflows the call stack).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return Buffer.from(binary, "binary").toString("base64");
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("usage: npm run doc:read-check -- <path-to.pdf>\n");
    process.exit(2);
  }
  const bytes = new Uint8Array(await readFile(file));
  const name = file.split("/").pop()!;
  const { client, model } = modelFor(process.env, "document");
  console.log(`file: ${name}  ${bytes.length} bytes  model: ${model}`);

  let seen: string | null = null;
  const recorder = { record: (model: string, u: unknown) => { seen = `${model} ${JSON.stringify(u)}`; } };

  const t0 = Date.now();
  const reading = await readDocument(client, { pdfBase64: bytesToBase64(bytes) }, name, model, recorder as never);
  console.log(`--- ${Date.now() - t0}ms ---`);
  console.log("documentKind   :", reading.documentKind);
  console.log("isMedicalReport:", reading.isMedicalReport);
  console.log("notReportReason:", reading.notReportReason ?? "(none)");
  console.log("text chars     :", reading.text.length);
  console.log("usage          :", seen);
  console.log("--- first 500 chars ---");
  console.log(reading.text.slice(0, 500));
}

// Guarded like ingest.ts and leaf-id-backfill.ts, and here the stakes are money rather than data:
// an unguarded top-level body bills an Opus document call the moment anything imports this file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`doc:read-check failed: ${(e as Error).message}\n`); process.exit(1); });
}

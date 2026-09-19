// The lab/dexa/scale parser dispatch — split out of ingest-core so that module
// stays parser-free. parseDexa pulls in pdfjs-dist (~500 KB); it's imported dynamically
// below (W47) so the browser fold path (ImportTab → import-flow → ingest-core) only pays
// that cost on an actual PDF upload, not on every page load.
// Imaging PDFs go through the LLM extraction path (report-extract), not here.
import type { MarkerResult, SourceRecord } from "./types";
import { parseHealthmatters, isHealthmatters } from "./parsers/healthmatters";
import { parseWeightApp, isWeightAppSheet } from "./parsers/weightapp";
import { lazyImport } from "./lazy-import";

// Pure — the parsers read the passed bytes, never disk.
export async function parseRawFile(
  bytes: Uint8Array,
  ext: string | undefined,
): Promise<{ kind: SourceRecord["kind"]; rows: MarkerResult[] }> {
  if (ext === "xlsx" || ext === "xls") {
    // Route by content, not the "else = healthmatters" assumption: a foreign spreadsheet
    // throws here so the browser catch queues it instead of mis-parsing into garbage.
    if (isWeightAppSheet(bytes)) return { kind: "scale", rows: await parseWeightApp(bytes) };
    if (isHealthmatters(bytes)) return { kind: "lab", rows: await parseHealthmatters(bytes) };
    throw new Error("unrecognized spreadsheet format");
  }
  if (ext === "pdf") {
    const { parseDexa } = await lazyImport(() => import("./parsers/dexa"));
    return { kind: "dexa", rows: await parseDexa(bytes) };
  }
  throw new Error(`unsupported file extension: ${ext}`);
}

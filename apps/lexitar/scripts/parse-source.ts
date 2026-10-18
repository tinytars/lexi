// W13g: thin Node wrapper around the pure byte-based parser in src/lib/parse-raw.ts.
// Reads a raw file from disk and hands its bytes to the shared dispatcher, so the CLI and the
// browser/Function ingest path parse identically (same xlsx/pdf logic, no fs in the core).
// Imaging PDFs are NOT handled here — they go through the LLM extraction path
// (scripts/claude-report.ts) and their pre-fold output lives in SourceRecord.extraction.

import { readFile } from "node:fs/promises";
import { parseRawFile as parseRawBytes } from "../src/lib/parse-raw";
import type { MarkerResult, SourceRecord } from "../src/lib/types";

export async function parseRawFile(abs: string): Promise<{ kind: SourceRecord["kind"]; rows: MarkerResult[] }> {
  const ext = abs.toLowerCase().split(".").pop();
  const bytes = new Uint8Array(await readFile(abs));
  return parseRawBytes(bytes, ext);
}

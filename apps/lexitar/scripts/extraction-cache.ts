// Content-addressed cache of report extractions, keyed by the PDF's sha256.
//
// A report's extraction is a nondeterministic LLM call: running `--dry-run` to
// preview and then re-running to apply produces TWO calls whose outputs can
// differ. This cache makes the preview authoritative — a fresh extraction (in
// either mode) is written here, and any later non-`--force` run reuses it, so
// apply commits exactly what dry-run showed. It is a pre-vault tier: once a PDF
// is applied, the vault's own `SourceRecord.extraction` is the source of truth
// and shadows this cache. The cache is a local, gitignored intermediate.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ProposedReport } from "./claude-report";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(here, "../.cache/extractions");

interface CacheEntry {
  extraction: ProposedReport;
  model: string;
  mode: string;
  cachedAt: string;
}

export async function readExtractionCache(sha256: string, dir = DEFAULT_DIR): Promise<ProposedReport | null> {
  try {
    const entry = JSON.parse(await readFile(resolve(dir, `${sha256}.json`), "utf8")) as CacheEntry;
    return entry.extraction ?? null;
  } catch {
    return null;
  }
}

export async function writeExtractionCache(
  sha256: string,
  extraction: ProposedReport,
  meta: { model: string; mode: string; cachedAt: string },
  dir = DEFAULT_DIR,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entry: CacheEntry = { extraction, ...meta };
  await writeFile(resolve(dir, `${sha256}.json`), JSON.stringify(entry, null, 2));
}

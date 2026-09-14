// Which source a command is talking about, and whether it has to do the work again.
//
// W76 — the decisions inside `scripts/commands/sources.ts`, separated from the fs and LLM calls that
// carry them out (the split that keeps ingest-core.ts at full coverage while ingest.ts stays a shell).
// Each of these decides whether a patient's readings are dropped, duplicated, or re-derived, and none
// of them could be asserted while they were expressions inside a 332-line file that also hashes files
// and shells out to an extractor.

import type { SourceRecord } from "./types";

export type TokenResolution<T> =
  | { kind: "one"; source: T }
  | { kind: "none" }
  /** More than one source answers to this token. The caller must not pick for the operator. */
  | { kind: "ambiguous"; matches: T[] };

const SHORT_PREFIX_MIN = 6;

/**
 * `--remove-source <token>` accepts a full id, an id prefix, the stored filename, or the original
 * filename. Removing a source drops every reading only it attested, so the wrong match is a data
 * loss, and a prefix is exactly the form that can name two things at once.
 *
 * W76 — this used to be a `.find()`, which silently took whichever ambiguous match came first in the
 * array. Ambiguity now comes back as ambiguity; the operator disambiguates.
 */
export function resolveSourceToken<T extends Pick<SourceRecord, "id" | "file" | "originalName">>(
  sources: readonly T[],
  token: string,
  basenameOf: (p: string) => string,
): TokenResolution<T> {
  const t = token.trim();
  if (!t) return { kind: "none" };
  const exact = sources.filter((s) => s.id === t || basenameOf(s.file) === t || s.originalName === t);
  // An exact match is never overruled by a prefix: a file literally named like another's id prefix
  // must not turn a precise instruction into an ambiguous one.
  const matches = exact.length ? exact : t.length >= SHORT_PREFIX_MIN ? sources.filter((s) => s.id.startsWith(t)) : [];
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "one", source: matches[0] };
}

export type IngestDecision = "skip-duplicate" | "reingest" | "fresh";

/** Re-ingesting the same bytes double-counts nothing but re-stamps provenance, so it needs --force. */
export function ingestDecision(priorExists: boolean, force: boolean): IngestDecision {
  if (!priorExists) return "fresh";
  return force ? "reingest" : "skip-duplicate";
}

export type ExtractionSource = "vault" | "disk-cache" | "fresh";

/**
 * Where a report PDF's extraction comes from. The order is the fix for a real nondeterminism: a
 * dry-run that previews an extraction writes it to the disk cache, so the apply that follows must
 * reuse THAT result rather than paying for a second, differently-worded call. The vault's own applied
 * extraction still wins over the cache — it is what the record was actually built from. --force means
 * the operator has asked for a new call and overrides both.
 */
export function extractionSource(hasVaultExtraction: boolean, hasDiskCache: boolean, force: boolean): ExtractionSource {
  if (force) return "fresh";
  if (hasVaultExtraction) return "vault";
  return hasDiskCache ? "disk-cache" : "fresh";
}

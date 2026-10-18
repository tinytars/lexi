// What counts as a raw file name, and how many pages one may have.
//
// Both halves are boundary validation for the same untrusted thing — a `{file}` a client names and
// a count a client reports — and both are needed by more than one raw route, so they live together
// rather than being re-derived per route.

/** A single path segment: no separators, no traversal. R2 keys are built by concatenation. */
export const isRawFileSegment = (s: unknown): s is string =>
  typeof s === "string" && /^[^/]+$/.test(s) && s !== "." && s !== "..";

export const isPdfFile = (file: string): boolean => file.toLowerCase().endsWith(".pdf");

/**
 * A sanity bound on the integer, NOT a limit on how long a stored report may be.
 *
 * The real limit is the corpus page ceiling, which is checked at inference time and refuses by name
 * (CORPUS.md). Capping here instead would reject the upload of a perfectly legitimate 100-page lab
 * report, and a rejected upload cannot be healed later. All this stops is a client writing a number
 * with no possible relationship to a document.
 */
export const MAX_PAGE_COUNT = 100_000;

export const isPageCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_PAGE_COUNT;

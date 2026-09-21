// What the report corpus refuses on, and nothing else.
//
// Apart from corpus.ts these are needed by the HTTP mapper in model-errors.ts, which every route
// that classifies a failure imports — including the CLI scripts. Keeping the classes here rather
// than beside the assembler is what stops that classification from dragging D1, R2 and the vault
// adapters into every one of those graphs.

export type CorpusLimit = "pages" | "bytes" | "documents";

/** The account may not read this client's namespace — or it is an orphan nobody may read (W76). */
export class CorpusDeniedError extends Error {
  readonly clientId: string;
  constructor(clientId: string) {
    super(`no readable report namespace for "${clientId}"`);
    this.clientId = clientId;
    this.name = "CorpusDeniedError";
  }
}

/**
 * A stored PDF has no page count, so the ceiling cannot be checked and the request cannot be sent.
 *
 * Carries file names because the remedy is per-file and the caller already owns them; a route that
 * answers a browser sends the COUNT only (see `inferenceErrorReply`).
 */
export class CorpusUnmeasuredError extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super(`${files.length} source document(s) have no page count`);
    this.files = files;
    this.name = "CorpusUnmeasuredError";
  }
}

/** D1 vouches for a document that is no longer in storage — a direct delete, or a half-run erasure. */
export class CorpusMissingError extends Error {
  constructor() {
    super("a source document recorded for this record is no longer in storage");
    this.name = "CorpusMissingError";
  }
}

export class CorpusTooLargeError extends Error {
  readonly limit: CorpusLimit;
  readonly actual: number;
  readonly max: number;
  constructor(limit: CorpusLimit, actual: number, max: number) {
    super(`this record holds ${actual} ${limit} of source documents; one request can carry at most ${max}`);
    this.limit = limit;
    this.actual = actual;
    this.max = max;
    this.name = "CorpusTooLargeError";
  }
}

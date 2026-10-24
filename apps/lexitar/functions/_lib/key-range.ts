// A key prefix as a range, because in D1 a prefix is not a `LIKE`.
//
// D1 caps a LIKE pattern at 50 bytes and answers `LIKE or GLOB pattern too complex: SQLITE_ERROR`
// above it — measured against health-identity-dev on 2026-10-20, 50 accepted and 51 refused, which
// is SQLite's own SQLITE_LIMIT_LIKE_PATTERN_LENGTH set far below its 50,000-byte default. Nothing in
// the error names a length, so it reads as a malformed pattern rather than a long one.
//
// That is not a limit a key prefix can be kept under. `{store}/regen-log/{client}/%` is 52 bytes with
// a uuid client id and 53 in prod, against 47 for `{store}/raw/{client}/%` — so registering the fourth
// namespace in raw-owner.ts's namespacePrefixes() crossed it, and every authorized `/api/raw/*` and
// `/api/chat-history/*` request threw on the ownership lookup every one of them passes through. The
// three that already fitted fitted by four bytes, and a client id is a name the patient chose, whose
// length was never ours to bound.
//
// So: no prefix match on an R2 key goes through LIKE. A range has no length limit, needs no escaping
// — `_` and `%` are wildcards in a pattern and literals in a comparison, and a client id may contain
// either — and reads the `r2_key` index instead of testing every row in the table.
//
// Kept free of every import so the operator scripts can use it too, for the reason namespace-key.ts
// gives: the one in scripts/raw-cipher-cli.ts is a hand copy of the query that broke.

/**
 * The longest `LIKE` pattern hosted D1 accepts, in bytes — SQLite's `SQLITE_LIMIT_LIKE_PATTERN_LENGTH`
 * set far below its own 50,000-byte default. Measured against health-identity-dev on 2026-10-20: 50
 * accepted, 51 refused with `LIKE or GLOB pattern too complex`.
 *
 * It lives here because this module is the thing that exists because of it, and it is exported so the
 * two suites that check it read one number: `tests/unit/key-range.test.ts`, which holds this module's
 * own arithmetic to it offline, and `tests/hosted/hosted-query.test.ts`, which re-measures it against
 * the live platform and fails if it has narrowed. A limit nobody re-measures is a measurement with a
 * date on it, and this one's date is the day an outage supplied it.
 */
export const D1_LIKE_PATTERN_LIMIT = 50;

export interface KeyRange {
  /** Inclusive lower bound — the prefix itself. */
  from: string;
  /** Exclusive upper bound — the prefix with its final character advanced by one. */
  to: string;
}

/**
 * The half-open range of keys beginning with `prefix`.
 *
 * `dev/raw/alex/` → `["dev/raw/alex/", "dev/raw/alex0")`, since `/` is 0x2F and `0` is 0x30. Every
 * key under the directory sorts inside it and the next sibling directory sorts outside.
 */
export function keyRange(prefix: string): KeyRange {
  if (prefix === "") {
    throw new Error("keyRange: an empty prefix is every key — say that in the query rather than here");
  }
  const last = prefix.charCodeAt(prefix.length - 1);
  // D1 compares TEXT as UTF-8 bytes, so advancing a non-ASCII final character is not the next string.
  // Every prefix here ends in `/`; refusing the rest is cheaper than a bound that is quietly wrong.
  if (last >= 0x7f) {
    throw new Error("keyRange: a prefix must end in an ASCII character for its upper bound to be derivable");
  }
  return { from: prefix, to: prefix.slice(0, -1) + String.fromCharCode(last + 1) };
}

/**
 * `(col >= ?n AND col < ?n+1)` and the two values to bind, for a prefix match inside a statement
 * whose parameters are numbered — one clause among several, where the numbering has to be explicit.
 */
export function prefixMatch(column: string, prefix: string, firstParam: number): { sql: string; binds: [string, string] } {
  const { from, to } = keyRange(prefix);
  return { sql: `(${column} >= ?${firstParam} AND ${column} < ?${firstParam + 1})`, binds: [from, to] };
}

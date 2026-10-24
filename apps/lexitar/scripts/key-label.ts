// How an R2 key is written to a terminal, a log or a run page.
//
// A KEY IS IDENTIFYING. `{store}/raw/{namespace}/{filename}` carries a client namespace — a display
// name for anything written before migration 0008, a derived namespace key since — and a filename the
// patient chose, which is routinely a person's name and a date. `{store}/data-{slug}.enc` carries the
// slug. None of that is content, and all of it names a person.
//
// This repository is public, so an Actions run page is readable by anyone, which is why `ops` and
// `snapshot` sat disabled: both print keys on their unhappy paths — a missing object, a size
// mismatch, an orphaned namespace, a deletion — and the unhappy path is exactly when somebody is
// reading the log. A redaction that only applied in CI would be the wrong shape: a terminal gets
// pasted into an issue, and the operator who needs the real key is the one who can ask for it.
//
// SO THE DEFAULT IS REDACTED AND `--keys` IS THE OPT-IN. The cost of forgetting the flag is re-running
// a read-only report; the cost of the opposite default is a disclosure that cannot be taken back. The
// hosted runs never pass it, and nothing in this repository passes it on their behalf.
//
// The label stays actionable. The digest is of the whole key, so the same object reads as the same
// `#abcd1234` in every run and on every machine: an operator matches a redacted alarm against a local
// `--keys` run by eye, with no decryption and no lookup table. What is kept is positional rather than
// a list of class names to maintain — the first segment is the store prefix and the second, for a
// directory key, is the key class, and both of those are already in the per-class counts beside it.

import { createHash } from "node:crypto";

const digest = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 8);

/** Whether this invocation asked for real keys. Default: it did not. */
export const showsKeys = (argv: string[] = process.argv): boolean => argv.includes("--keys");

/**
 * A key, rendered for a reader who is not entitled to the person it names.
 *
 * `prod/raw/0b8c/labs-2026.pdf` → `prod/raw/#1f3c9a2b`
 * `prod/data-0b8c.enc`          → `prod/data-#4c7e0d11`
 */
export function keyLabel(key: string, show: boolean = showsKeys()): string {
  if (show) return key;
  const segs = key.split("/");
  if (segs.length >= 3) return `${segs[0]}/${segs[1]}/#${digest(key)}`;
  if (segs.length === 2) {
    const cls = /^([a-z][a-z-]*-)/.exec(segs[1]);
    return `${segs[0]}/${cls ? cls[1] : ""}#${digest(key)}`;
  }
  return `#${digest(key)}`;
}

/**
 * A bare client namespace — `orphanedNamespaces()`'s map key, which is a name rather than a path and
 * so has no safe segment at all.
 */
export function nsLabel(ns: string, show: boolean = showsKeys()): string {
  return show ? ns : `#${digest(ns)}`;
}

/** The one line that tells an operator how to see what was redacted. Printed where keys were hidden. */
export const KEYS_HINT = "keys redacted — re-run locally with --keys to see them";

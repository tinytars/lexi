// W77 — how many `raw_objects` rows name an account that is not the record's subject.
//
// WHY THIS EXISTS. Five write sites record the CALLER's account rather than the subject's
// (chat-history/[id].ts, document-extract.ts, raw/[[path]].ts, regen-log/[id].ts), so an object a
// clinician writes into a patient's namespace under a live grant is attributed to the clinician.
// erasure.ts then finds it inside the patient's namespaces, counts it as `unattributable` and — by
// design, because deleting by prefix would destroy a third party's only copy on a slug collision —
// never deletes it. That patient's erasure reports `complete: false` for ever.
//
// Fixing the write sites stops new rows. It cannot move the ones already written: recordRawObject is
// INSERT OR IGNORE, so it can neither reassign nor be made to. This counts what is already there,
// before anything is decided about a repair.
//
// NO DECRYPTION, WHICH IS WHAT BOUNDS WHAT IT CAN ANSWER. A namespace segment is a client key that
// exists only inside the encrypted vault, so "whose record is this" generally needs the org key
// (scripts/raw-backfill.ts, which decrypts). Two answers are available without one:
//
//   CONFIRMED  a newer vault keys its first client by the lowercased ACCOUNT ID (App.svelte's
//              createFirstClient), so where the namespace segment IS a live account id the subject is
//              known outright. A row there naming another account is a mis-attribution, measured.
//   CANDIDATE  a namespace nothing here can resolve, whose rows carry more than one distinct
//              account_id. One of them is wrong and which one needs the vault, so it is counted and
//              reported, never guessed.
//
// A namespace segment is IDENTIFYING — a display name for anything written before migration 0008 —
// so it is redacted by default and `--keys` is the opt-in, exactly as scripts/orphan-sweep.ts is. An
// account id is not: it is the form a roster is allowed to take, and it is why the confirmed half is
// resolvable at all, so those namespaces print as themselves.
//
// SELECT ONLY. Nothing here writes a row under any flag; the repair, if there is to be one, is a
// separate decision needing the org key and an operator.
//
//   npm run raw:attribution-audit            # report only
//   npm run raw:attribution-audit -- --keys  # also show the unresolved namespaces (local terminal)

import "./load-creds";
import { d1 } from "./d1-remote";
import { erasedClientIdOfObjectKey } from "../functions/_lib/namespace-key";
import { normalizeClientId } from "../src/lib/client-id";
import { nsLabel, showsKeys, KEYS_HINT } from "./key-label";
import { assertTargetConsistent, describeTarget } from "./target";
import { isMain } from "./is-main";

interface Row {
  r2_key: string;
  account_id: string;
}

/** One namespace's rows, as counts per attributed account. */
export interface Namespace {
  /** Rows by account id, insertion-ordered so the report is stable across runs. */
  accounts: Map<string, number>;
  /** Rows by key class — `raw`, `text`, `regen-log`, `orphaned-chat`, `chat`. */
  classes: Map<string, number>;
}

/**
 * Which class of key this is, positionally: the second segment of a directory key, else the flat
 * key's own prefix up to its first hyphen. Positional rather than a list of names to keep in step
 * with storeKey's call sites — the same reasoning key-label.ts keeps a key's first two segments
 * under redaction, and `data-` must not read as `chat-` merely because both are flat.
 */
export function keyClass(key: string): string {
  const segs = key.split("/");
  if (segs.length >= 3) return segs[1];
  return /^([a-z][a-z-]*)-/.exec(segs[segs.length - 1] ?? "")?.[1] ?? "unknown";
}

/** Rows grouped by the namespace an erasure counts them under. Rows in none are only counted. */
export function byNamespace(rows: Row[]): { namespaces: Map<string, Namespace>; unnamespaced: number } {
  const namespaces = new Map<string, Namespace>();
  let unnamespaced = 0;
  for (const row of rows) {
    const ns = erasedClientIdOfObjectKey(row.r2_key);
    if (!ns) {
      unnamespaced += 1;
      continue;
    }
    const entry = namespaces.get(ns) ?? { accounts: new Map(), classes: new Map() };
    entry.accounts.set(row.account_id, (entry.accounts.get(row.account_id) ?? 0) + 1);
    const cls = keyClass(row.r2_key);
    entry.classes.set(cls, (entry.classes.get(cls) ?? 0) + 1);
    namespaces.set(ns, entry);
  }
  return { namespaces, unnamespaced };
}

/** Rows in `ns` attributed to anybody but `subject`. */
export const misattributed = (ns: Namespace, subject: string): number =>
  [...ns.accounts].reduce((n, [account, rows]) => (account === subject ? n : n + rows), 0);

const tally = (m: Map<string, number>): string =>
  [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");

async function main(): Promise<void> {
  assertTargetConsistent();
  process.stdout.write(`${describeTarget()}\n`);

  const rows = await d1<Row>("SELECT r2_key, account_id FROM raw_objects");
  const accounts = await d1<{ id: string }>("SELECT id FROM accounts WHERE deleted_at IS NULL");
  // The subject is known only where the namespace IS an account id, so the lookup is by the
  // normalised form a namespace segment would carry.
  const subjectOf = new Map(accounts.map((a) => [normalizeClientId(a.id), a.id]));

  const { namespaces, unnamespaced } = byNamespace(rows);
  process.stdout.write(`raw_objects rows: ${rows.length}   live accounts: ${accounts.length}\n`);
  process.stdout.write(`client namespaces: ${namespaces.size}   rows in no namespace: ${unnamespaced}\n`);
  // Which classes are present at all, because the answer bounds the defect: `orphaned-chat` is the
  // one key the escape hatch always writes fresh, so INSERT OR IGNORE can never make its
  // mis-attribution a no-op the way a pre-existing chat row does.
  const allClasses = new Map<string, number>();
  for (const e of namespaces.values()) {
    for (const [cls, n] of e.classes) allClasses.set(cls, (allClasses.get(cls) ?? 0) + n);
  }
  process.stdout.write(`by class: ${tally(allClasses)}\n`);

  const confirmed: Array<[string, Namespace, string, number]> = [];
  const candidates: Array<[string, Namespace]> = [];
  for (const [ns, entry] of namespaces) {
    const subject = subjectOf.get(ns);
    if (subject) {
      const wrong = misattributed(entry, subject);
      if (wrong) confirmed.push([ns, entry, subject, wrong]);
    } else if (entry.accounts.size > 1) {
      candidates.push([ns, entry]);
    }
  }

  // A "none" that examined nothing is not a measurement, so each half says what it could reach:
  // the confirmed one sees only namespaces that ARE an account id, the candidate one only those with
  // more than one attributed account. Anything in neither is a namespace this tool cannot judge.
  const resolved = [...namespaces.keys()].filter((ns) => subjectOf.has(ns)).length;
  const split = [...namespaces.values()].filter((e) => e.accounts.size > 1).length;
  process.stdout.write(
    `examined: ${resolved} of ${namespaces.size} namespaces resolvable to a subject, ` +
      `${split} with more than one attributed account, ` +
      `${namespaces.size - resolved - split + [...namespaces.entries()].filter(([ns, e]) => subjectOf.has(ns) && e.accounts.size > 1).length} unjudgeable\n`,
  );

  const confirmedRows = confirmed.reduce((n, [, , , wrong]) => n + wrong, 0);
  process.stdout.write(`\nCONFIRMED — namespace is a live account id and the row names another account\n`);
  if (!confirmed.length) process.stdout.write(`  none\n`);
  for (const [ns, entry, subject, wrong] of confirmed.sort((a, b) => b[3] - a[3])) {
    // The namespace IS the subject's account id here, so printing it discloses an account id and
    // nothing more — which is the form this estate's rosters are allowed to take.
    process.stdout.write(`  ${ns}  subject ${subject}  mis-attributed ${wrong} of ${tally(entry.accounts)}\n`);
    process.stdout.write(`    by class: ${tally(entry.classes)}\n`);
  }
  process.stdout.write(`  TOTAL: ${confirmedRows} rows across ${confirmed.length} namespaces\n`);

  const candidateRows = candidates.reduce((n, [, e]) => n + [...e.accounts.values()].reduce((a, b) => a + b, 0), 0);
  process.stdout.write(`\nCANDIDATE — namespace unresolvable without the org key, rows split across accounts\n`);
  if (!candidates.length) process.stdout.write(`  none\n`);
  for (const [ns, entry] of candidates.sort((a, b) => b[1].accounts.size - a[1].accounts.size)) {
    process.stdout.write(`  ${nsLabel(ns)}  ${entry.accounts.size} accounts: ${tally(entry.accounts)}\n`);
    process.stdout.write(`    by class: ${tally(entry.classes)}\n`);
  }
  process.stdout.write(`  TOTAL: ${candidateRows} rows across ${candidates.length} namespaces\n`);
  if (!showsKeys()) process.stdout.write(`\n${KEYS_HINT}\n`);

  process.stdout.write(
    `\nRepair, if any, is a separate decision: recordRawObject is INSERT OR IGNORE, so moving a row ` +
      `needs a reassign mode on scripts/raw-backfill.ts and the org key passphrase.\n`,
  );
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}

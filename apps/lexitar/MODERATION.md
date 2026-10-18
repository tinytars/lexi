# Reporting and moderation — who reads a complaint, and what they can do about it

A health-literacy tool that answers questions about someone's own medical records can be wrong in
ways that matter, and the people sharing a record with each other can behave badly. This is the
document for both: how a user says so, who reads it, how fast, and — the part most moderation
policies skip — what the operator is and is not able to do about it afterwards.

Accountable for every report: **the Tiny Tars Foundation's safety contact**, reachable through the
Foundation's contact page. The Foundation is the accountable body and the contact is a standing role
within it, so the commitment outlives whoever holds it. Response target, quoted verbatim from what the
product tells the user as they file:

> A person reads every report. We aim to acknowledge within 3 business days and to resolve within 10;
> reports of illegal material are looked at within 1 business day.

Both of those are single strings in `src/lib/brand.ts` (`SAFETY_OWNER`, `SAFETY_RESPONSE`) and
`tests/unit/brand.test.ts` pins this page against them, so the page and the product cannot come to
disagree about who answers or how fast.

## 1. How a report is made

Three controls, one route (`functions/api/report.ts`), three reasons:

| Control | Reason | What it is for |
|---|---|---|
| **Report** on a chat answer | `misleading-answer` | An answer that could mislead or harm |
| **Report** on a leaf's action menu | `misleading-answer` | The same, on generated content outside chat |
| **Report** beside a provider's row in *Who can access my record* | `abusive-account` | An account behaving abusively |
| Any of the above | `illegal-content` | Illegal or abusive material |

Reports need an account: a crash report is worth taking from anyone, an accusation about another
account is not. Each report is rate-limited (five per address per hour, shared with the crash
reporter's budget) and filed as an issue in the private `promontory-studio/plover-factory` tracker,
labelled `safety-report` and `kind:<reason>`. That tracker's autopilot fixer only acts on
`client-error`, so nothing here is ever auto-patched by a bot — a person reads it.

The tracker, and not an inbox, because the response target above has to be measurable after the
fact: an issue timestamps its own open and close and an email does not.

## 2. What a report contains, and what it cannot

It carries the reporter's account id, the reason, which part of the product they were in, an id this
app issued for what they were looking at, and their own words. It carries **no health content** — no
document, no marker value, no client name, not the answer complained about. Their own words are
scrubbed on the way in (`functions/_lib/client-error.ts`), because someone describing a bad answer
will quote it back and the quote is the patient's own record.

So a reviewer's first move is to **ask the reporter**. That is the deliberate trade: the report is
enough to make contact and not enough to read a stranger's record.

## 3. What the operator can and cannot see

**Uploaded originals cannot be scanned server-side, by design.** Every upload goes through one lane
(`PUT /api/raw/{id}/{file}`) and is sealed in the browser under a per-file content key held inside
the user's own encrypted vault (`VAULT.md` §2a). The operator does not hold that key. There is no
server-side view of a document's contents to run a classifier over, and adding one would mean
holding the key — which is the property the product exists to have.

Stated exactly, because it has been becoming true in stages:

- **New uploads: unconditional.** The route refuses unsealed bytes outright
  (`415 plaintext_refused`). Nothing readable can be written any more.
- **Older uploads: draining.** Objects written before the sealing landed (2026-09-24) are still
  stored readable. Two lanes empty that backlog — the owner's own browser seals what it opens
  (`src/lib/raw-seal-heal.ts`), and an operator sweep seals the rest
  (`scripts/raw-encrypt-backfill.ts`). Until both have run to zero on both stores, "the operator
  cannot read an uploaded document" is true of new uploads and not yet true of every old one.

This section is updated when the sweep reports zero sealable objects, and not before.

What the operator *can* see: account ids, R2 object keys, sizes, page counts, timestamps, and the
audit log. Not contents.

## 4. Removal

Two different removals, and a report has to be read for which one it needs:

- **The owner's.** `DELETE /api/raw/{id}/{file}` is session-gated and requires a proven ownership
  claim, so it is the *patient's* delete — the operator cannot call it on their behalf. A user can
  also delete their whole account and everything in it from the account panel.
- **The operator's.** The ciphertext object is removed out of band, through the `ops.yml` R2 lane.
  This is possible precisely because deleting never requires reading: an operator who cannot open a
  file can still destroy it. It is what a confirmed report of illegal material gets.

Neither removal reaches the model provider's prompt cache. A report that documents were sent there is
answered with what is true: deleting the account stops anything further being sent — erasure revokes
every session before it tombstones the account, so the browser's keepalive dies — while an entry
already written expires on the provider's own schedule, which this deployment can neither shorten nor
recall. Nor does either reach a record already exported to a computer with `npm run record:export` — a file on
a disk this deployment has never seen, written by the patient, by a tool holding their credential, or by
an account they approved access for, and outliving that approval in the last case. `SECURITY.md`
§*What deletion reaches* states both limits in the same words the user is shown.

Access between accounts is separate again: revoking a provider ends their access to that record
immediately, and is the user's own control. Reporting them is what revoking is not — it reaches
someone who can act beyond that one record.

## 5. Age

The service is for people aged **16 and over**, and the limit is enforced in the browser at signup
and on later edits (`src/lib/age-limit.ts`). Be precise about what that is worth: a birth **year**
is collected, never a full date, and it never reaches the server — the server records only that the
check was passed and when (`accounts.age_attested_at`). So it is a **year-granular self-declaration**,
not a verified age. A report that an account belongs to a child is handled as
`abusive-account` and ends in the account erasure of §4.

## 6. Related

- `SECURITY.md` — the threat model and the processors involved.
- `CORPUS.md` — what leaves the deployment when an answer is generated, and for how long.
- `VAULT.md` §2a — the per-file content keys this document's §3 rests on.

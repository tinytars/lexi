# Security policy

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/tinytars/lexi/security/advisories/new)
rather than opening a public issue. Include a description of the issue and, if you have one, a
minimal reproduction.

We aim to acknowledge reports within 5 business days. There is no bug bounty; this is a
volunteer-maintained project from a 501(c)(3).

## This repo carries no patient data, ever

Nothing under `apps/lexitar` or `packages/frame` stores, seeds, or fixtures real account or health
data. A running deployment's actual patient data lives only in Cloudflare R2 and D1, encrypted
client-side under keys the operator never holds — the vault blob under the account's own key, and
each uploaded original under a per-file content key that exists only inside that blob. It is
reachable exclusively through the deployed app over its authenticated API, never through this
repository or its git history. If you believe you have found real patient data committed here,
treat it as the most urgent class of report this policy covers.

One limit, stated plainly: answering questions about a patient's own documents means decrypting them
in memory, in the deployment, to send them to the model provider — and the trigger is the owner
**using** the record, not asking a question. `functions/api/corpus-warm.ts` sends the whole set when a
record is opened, before any question exists, and the browser keeps that prompt-cache entry warm for
up to twelve idle refreshes (`apps/lexitar/CORPUS.md` §4: `MAX_IDLE_KEEPALIVES = 12`, about 54 minutes
of designed residency after the patient stops interacting). Encryption at rest defeats bucket
exposure, a leaked storage token, a snapshot and a backup copy, and it removes the operator's standing
ability to read any patient's files — it does not hide a document from the running deployment, or from
the model provider, while its owner has the record open. `apps/lexitar/VAULT.md` §2a and
`apps/lexitar/DPGA.md` describe that path in full.

Two further limits belong here rather than in a gap list, because a numbered list is what
`grant-redeem.ts` used to point at and that list no longer exists.

**One path reads a vault blob with no session at all.** `GET /api/vault/{id}` accepts an operations
bearer token (`VAULT_TOKEN`) for continuous-integration and operational traffic. It returns ciphertext
and no key, so it is not a way to read a record — but it *is* a read of a patient's object, and until
2026-09-27 it established no identity and left no trace. It now records one access row per read,
attributed to the organization account as actor with the vault's owner as subject
(`vault_blob_read_ops`), which is the only honest attribution available: the token names no person. An
unaudited privileged read path is the thing this repo stopped having, and the branch that had no
principal is not an exemption from that.

**Credential guessing is throttled on the password pair only.** `POST /api/auth/password/login` and
`/salt` count attempts per address and per network in the database (`functions/_lib/auth-budget.ts`) and
refuse a burst, deliberately failing *open* if the counter is unavailable — locking a family out of
their own health record is worse than the attack it would prevent, and the guesser still pays a
200,000-iteration derivation per attempt and still cannot pass the stored verifier.
`POST /api/auth/recovery/grant-redeem` is **not** throttled: an unknown address has no grant to count
against, so enumeration through that route is bounded only by whatever general rate limiting the
deployment has. That asymmetry is accepted and stated, not solved.

## The processors that see patient data

| Processor | What reaches it | Terms |
|---|---|---|
| **Cloudflare** — Pages, R2, D1 | Ciphertext and request logs. It holds no key that opens a vault blob or a sealed original. | Standard commercial terms. |
| **Anthropic**, or whichever provider `inference.config.json` names | **Whole documents, in plaintext**, plus answer text. The most sensitive flow in the product. | Standard commercial API terms. **No BAA and no negotiated zero-retention agreement.** A prompt-cache entry expires on the provider's own timetable, which the deployment can neither shorten nor recall. `REPORTS: "never"` turns the mechanism off per environment. |
| **Microsoft Azure AI Speech** | Read-aloud text — answer text, so PHI. | An in-scope service under Microsoft's Product Terms HIPAA BAA (`apps/lexitar/API.md` §`/api/speak`). Whether this deployment's subscription has that BAA in force is unconfirmed, so nothing user-facing claims it. |
| **Google Workspace, Gmail API** | Transactional mail: an address and a message body carrying no health content (`functions/_lib/email.ts`). | Workspace terms; sent by domain-wide delegation from a Foundation mailbox. |

Stated as an honest blank rather than an implied guarantee: **retention at the model provider has not
been negotiated.** That is an open item, not a solved one. Google sign-in is not a processor here —
it is deferred and does not ship (`apps/lexitar/AUTH.md`).

### What deletion reaches, and what it cannot

A user deletes their account and everything under it from the account panel
(`POST /api/account/erase`). Two limits are stated in the product's own words rather than left for
someone to discover:

- **Storage the server cannot prove is theirs** — objects uploaded before ownership was recorded, or
  in a namespace another account wrote into first — is reported as a count and left in place. An
  erasure that leaves any is reported as **incomplete**; nobody is told their data is gone when it is
  not (`functions/_lib/erasure.ts`).
- **The model provider's prompt cache.** Erasure revokes every session first, so the browser's
  keepalive stops and nothing further is sent — that half is enforced and tested. An entry already
  written expires on the provider's own timetable, which this deployment can neither shorten nor
  recall, and there is no number to report because the deployment cannot see that cache.
- **A record exported to a computer.** `npm run record:export` writes a record readable to a machine
  (`apps/lexitar/scripts/record-export.ts`). Erasure cannot reach a file on a disk it has never seen.
  The export refuses any destination inside a git work tree, lands 0700 outside every checkout, and
  `--purge` removes it — but that is the operator's lever, not the patient's, and the wording says so
  rather than implying deletion reaches it. **Three holders, not one:** the person themselves, a tool
  signed in as them, and — since the export principal shipped (`apps/lexitar/VAULT.md` §4b) — an
  account they approved access for. That third copy is the one the wording had to grow for, because it
  **outlives the approval that produced it**: revoking the access, and the seven-day window expiring,
  both stop further reads and neither removes a file already written. Someone approving seven days is
  agreeing to a file that does not expire with the grant, which is why the sentence they are shown says
  so and why `docs/RECORD-EXPORT.md` says it again to the operator.

The same sentences appear in the deletion result the user sees (`ERASURE_REACH` in
`apps/lexitar/src/lib/erase-account.ts`) and in `apps/lexitar/MODERATION.md` §4.

## Where readable patient data is allowed to land

Everything above concerns data in transit to a processor. One flow deliberately writes readable patient
data to a person's own computer: `npm run record:export`, which reads over the ordinary authenticated
API and decrypts locally. `apps/lexitar/VAULT.md` §4a is the mechanism; the convention it establishes,
which the next such tool inherits, is four rules — and a fifth that applies whenever the record is not
the runner's own.

- **A destination outside every checkout, mode 0700**, enforced at run time by the program rather than
  by an ignore rule — this repo is public and its `.gitignore` re-includes `records/**`, so an ignore
  rule is not a control.
- **Contents-free output.** A run prints ids, counts, checksums, sizes and whether each file opened,
  never the record itself, because the common caller is an agent whose transcript must not become a
  second copy of it.
- **A removal command the run itself prints.** It shortens the window; it does not make the copy
  reachable by the patient's own erase, which is why the deletion section above names it.
- **Never a CI job.** The export is deliberately absent from `.github/workflows/ops.yml`, whose own
  header otherwise directs every new operational flow there: a hosted runner is the wrong place for
  plaintext patient data, and read-only inspection in this repo stays local by convention
  (`apps/lexitar/scripts/treatment-diagnose.ts`).

The fifth rule covers **someone else's record on the runner's disk**, which is what the export
principal made possible (`apps/lexitar/VAULT.md` §4b, operator guide `apps/lexitar/docs/RECORD-EXPORT.md`).
Egress to a computer that is not the subject's is permitted only where all four of these hold, and a
tool that drops any one of them is not the same category of thing:

- **the subject approved it, for a window they chose**, from their own unlocked session — no
  server-side path can grant it, because the key is wrapped in their browser;
- **every read is on their own access screen**, with them as the subject, permanently — those rows
  survive account erasure by design;
- **the credential that sits between runs opens nothing by itself** — it holds no record's key, no
  session token and no account key, and expires into uselessness when the window does;
- **no index of who exists is written to disk.** A map from the labels in a pasted address to the
  people they name is itself the fact the record protects, so it is resolved in process, for the run
  only, and a resolution that would require opening an unrelated person's record refuses rather than
  looking (`--probe` is the explicit, announced opt-in).

What none of that changes is the file: a copy already written outlives both the window and the
revocation, which is why the deletion section above names it and why the subject is told so in the
sentence they are shown.

## Scope

In scope: `apps/lexitar` (the LexiTar web app — Svelte UI, `functions/` Pages Functions backend,
`scripts/` ingest CLI) and `packages/frame` (`@tinytars/frame`, the session/auth controllers and
UI it drives — `vault-session.svelte.ts`, `roster-session.svelte.ts`, `vault-principals.svelte.ts`,
`recovery-controller.svelte.ts`, `support-access.svelte.ts`, `account-methods.svelte.ts`,
`LoginScreen.svelte`, `Onboarding.svelte`, `AccountMenu.svelte`, and the rest).

Out of scope: the cryptography and access-policy primitives both of the above build on — those
live in [`@tinytars/vault`](https://github.com/tinytars/vault) and have their own `SECURITY.md`. A
report that turns out to be about key derivation, envelope framing, or access resolution rather
than this repo's own session orchestration or application logic belongs there, not here.

## Supported versions

Only the latest deployed revision of `apps/lexitar` and the latest published minor version of
`@tinytars/frame` receive security fixes, per `CHANGELOG.md`. `@tinytars/frame` is pre-1.0; expect
breaking changes between minor versions until 1.0.0.

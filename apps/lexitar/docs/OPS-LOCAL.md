# The vault operations that run on your own computer

Twelve of the thirteen operations this application has cannot run in continuous integration, and as
of 2026-10-19 the dispatch form no longer offers them. This document is where they went. It is the
runbook: what each one does, the command, and what a real run cannot be undone from.

They are here rather than in the workflow for two reasons, and the second is the one that mattered.

**None of them can work on a hosted runner.** Every operation under `npm run r2-ops`, plus
`raw-backfill`, `raw-pages-backfill`, `raw-encrypt-backfill` and `recovery-approve`, reaches
`scripts/org-unwrap.ts`, so each needs the organisation's **private** key. That key file never
arrives: `scripts/org-key.ts:33` resolves `ORG_KEY_PATH` or a credential store's `org-key.json` and
has no in-repo fallback, and no workflow sets either. A dispatch therefore failed on the key, every
time, after installing the repository and billing the minutes. `ORG_KEY_PASSPHRASE` being in Actions
secrets did not change that — a passphrase opens nothing without the key it decrypts.

Putting the private key in Actions secrets would fix it and is **declined**: it would give every
workflow-dispatch a recovery envelope into every vault, which is the capability the October 2026
remediation was for. That decision is the reason this document exists instead of a config change.

**And the form itself disclosed a person.** `tinytars/lexi` is public, so a workflow's dispatch
inputs and its run page are readable by anyone. `client` took an account id — and for
`recovery-approve` it took *the patient's own email address* — while `reason` took free text that
the composite action echoed into the run summary. A run page naming who an operation was run for is
a disclosure whether or not the operation then failed on a missing key, and twelve of the thirteen
could only fail. Both inputs are gone, and with them the per-client concurrency key that spelled an
account id into a group name.

## Before any of these

```
export LEXI_CREDENTIALS_DIR=~/PabloTech/lexi-keys
```

`scripts/org-key.ts` finds `org-key.json` through it, falling back to `PLOVER_CREDENTIALS_DIR`. See
`apps/lexitar/CREDENTIALS.md`. Run everything below from `apps/lexitar`, and nothing below is a
dispatch — these are commands you type.

**`--dry-run` is the contract every one of them honours**: no Anthropic call, no R2 write. Run it
first. Where a real run is irreversible outside the nightly snapshot window, the table says so, and
there `npm run vault:snapshot:check` being green is the precondition, not a formality.

**A real run also needs `PLOVER_ALLOW_LOCAL_VAULT_WRITE=1`**, and the acknowledgement is the point
of it rather than an obstacle. `assertLiveWriteAllowed` (`scripts/vault-sync.ts:158`) refuses a
write to the live bucket from a workstation, because `wrangler r2 object put` has no conditional
option: a save the record's owner makes mid-write is lost silently, with nothing afterwards to show
it happened. Nothing serializes these — the dispatch lane that once did cannot run them — so you
are the serialization. Confirm the owner is not in the record, then set it for that one command:

```
PLOVER_ALLOW_LOCAL_VAULT_WRITE=1 npm run r2-ops -- --reconcile --client <client>
```

It banners to stderr every time, by design. Exporting it into your shell turns a per-command
acknowledgement into an ambient one, which is the whole thing the guard is for.

## The operations

`<client>` is a vault id (`alex`), never an email, except where the table says otherwise.

| Operation | Command (add `--dry-run` first) | A real run |
|---|---|---|
| refresh-finding | `npm run r2-ops -- --refresh-finding --client <client>` | Billed Anthropic call; rewrites the finding. `--force` regenerates even when the plan says nothing changed |
| refresh-ranges | `npm run r2-ops -- --refresh-ranges --client <client> --marker <name>` — or `--all-markers` for every marker with readings | Billed; rewrites ranges. `--force` as above |
| refresh-marker-groups | `npm run r2-ops -- --refresh-marker-groups --client <client>` | Billed; rewrites groups. `--force` as above |
| process-pending | `npm run r2-ops -- --process-pending --client <client>` | Billed; drains the pending queue |
| reconcile | `npm run r2-ops -- --reconcile --client <client>` — omit `--client` to fan out across every deployed vault | Writes whatever it found to be out of step |
| sync-treatment-attachments | `npm run r2-ops -- --sync-treatment-attachments --client <client> [name]` — omit the name for every treatment | Re-links attachments |
| treatment-groups-backfill | `npm run r2-ops -- --treatment-groups-backfill --client <client>` | Writes groups for treatments that have none |
| treatment-photo-extract | `npm run r2-ops -- --treatment-photo-extract --client <client> --name <treatment>` | Billed; patches one treatment. `--key raw/abc.jpg --id row_123` select specific objects and have no menu entry anywhere |
| raw-backfill | `npx tsx scripts/raw-backfill.ts --confirm` | Store-wide against D1, not per-client |
| raw-pages-backfill | `npx tsx scripts/raw-pages-backfill.ts --confirm` | Store-wide. Reads every PDF in the store to count its pages, so it is the slowest of these, and the dry run reads them all too. **`--purge-unreadable` DELETES the PDFs no parser can open** — irreversible outside the snapshot window |
| raw-encrypt-backfill | `npx tsx scripts/raw-encrypt-backfill.ts --confirm` | Store-wide. **Overwrites patient objects in place** with their sealed form; the nightly snapshot is the only undo. The dry run's counts are the migration's remaining work |
| recovery-approve | `npm run recovery:approve -- --email <account email> --confirm` | The one command here that takes an email rather than a vault id, which is why it could not stay on a public form |

## orphan-sweep is the one that stayed

`orphan-sweep` does not reach the organisation's key, so it runs on a hosted runner and is the only
remaining choice in `.github/workflows/ops.yml`. Locally it is
`npx tsx scripts/orphan-sweep.ts --record`; a real run only *dates* orphans, and deleting them needs
`--delete`, which is deliberately not a form input in either place.

## If one of these should run in CI again

It is a decision about the organisation's private key and not a change to a workflow file, so it is
taken first and the workflow follows. The alternative that does not need the key is to give the
operation a narrower credential of its own — which is a change to `scripts/org-unwrap.ts`'s callers,
not to the dispatch surface.

The rule the workflow's own header states still holds and is what keeps this from being reinvented:
a new operational flow is an entry in that file and never a second workflow. What 2026-10-19 adds to
it is that **an entry is also a claim the operation can run on a hosted runner** — so an operation
that cannot belongs in this document instead.

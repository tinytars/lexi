# Exporting a health record from the command line

`npm run record:export` writes a complete, readable copy of **one** health record to this computer:
the structured record, every stored document, and the extracted text of each. It exists so a record
can be read, searched and kept by the person it belongs to, outside this application.

It runs as one of two principals, and the difference is the whole of this document:

- **the record's own owner**, typing their own password — the original behaviour, unchanged, and what
  you get when you pass no flags;
- **the export principal**, a dedicated account that owns no record and reads only what a person has
  explicitly approved it for, for as long as they approved it. That is the case one operator uses to
  export a whole family's records without being each of those people.

Everything the export principal reads is a disclosure, and is recorded on the record owner's own
Access screen. That is not a side effect of the design; it is the reason the design is acceptable.

## Who may run this

The export principal is not a way to read a record nobody approved. It holds a password, and that
password on its own opens nothing at all — it lets the tool say who it is. A record becomes readable
only while its owner has an approval live, and it stops being readable the moment they revoke it or
the window elapses. The credential cannot issue an account-recovery code and cannot write to a
record; both are refused by the server, and both are pinned by tests, so neither can be undone by
accident (`tests/unit/support-principal.test.ts`).

So: run it for people who have approved it, and expect to ask them again every week.

## One-time provisioning

Skip this if `LEXITAR_SUPPORT_EMAIL` and `LEXITAR_SUPPORT_PASSWORD` are already in
`plover-keys/health-dash.env` — they are, for the dev database.

The account is minted out of band, because no self-service signup creates one: the script computes
the crypto locally and emits SQL to apply with wrangler.

```sh
EMAIL=record-cli@local.invalid PASSWORD='<generate a long random one>' \
  DISPLAY_NAME="Record Export CLI" \
  npm run --silent support:provision > /tmp/support.sql
npm run wrangler -- d1 execute health-identity-dev --remote --file /tmp/support.sql
```

`--silent` is not optional: npm's own banner would otherwise land in the SQL file and wrangler would
reject the first statement. Do **not** set `RESET=1` against a database holding real links — it
deletes the grants patients approved and the audit rows that are their evidence of who read their
record (`scripts/provision-support-account.ts`).

Then record the two values in `plover-keys/health-dash.env`:

```
LEXITAR_SUPPORT_EMAIL=record-cli@local.invalid
LEXITAR_SUPPORT_PASSWORD=<the password you generated>
```

The names are deliberately not the `LEXITAR_CLI_*` pair. A record owner's password is also the key
that opens their record, and that one is stored nowhere — not here, not in the credentials repository
(`scripts/rotate-pilot-credentials.ts`). A support account owns no record, so its password is a key to
nothing. `VAULT.md` §4a states the distinction in full; keeping the two names apart is what stops the
older rule from quietly becoming false.

## How a person grants access

This is the step no command line can perform, by design. The key that opens a record is wrapped in
that person's own browser and the server never holds it, so only their unlocked session can hand a
copy to anyone else.

1. **The tool asks.** `npm run record:export -- --request <their email>` files the request and prints
   who has to approve it. Nothing is readable yet.
2. **They approve.** They open the app, unlock their record, open **Access**, and find
   **Record Export CLI · support · wants to help** under *Support access requests*. They choose
   **7 days** in the dropdown beside it — it is not the default — and press **Approve**.
3. **The tool reads.** Every run for the next seven days works unattended.

**What they are agreeing to.** An account that is not theirs may read their whole record — the
structured data and every document — for the window they chose, and a copy of it will exist as
readable files on the operator's computer. They are not agreeing to let it change anything, and they
are not agreeing to anything permanent: the approval expires by itself, and **Revoke** ends it
immediately.

## What they see, and how they stop it

- **Email.** They are emailed when they approve access, and again the first time that access is used
  inside the window — once per window, not once per run, so the message that matters is not buried
  under a daily one. Both name the expiry and where to revoke, and neither names a document.
- **Their Access screen.** Every open the tool performs is a row on their own access screen, with
  them as the subject: the grant itself, each open, and each document read. Those rows are permanent —
  account erasure deliberately keeps them (`functions/_lib/erasure.ts`), because they are the evidence
  of who read the record.
- **Revoke.** The entry under Access has a **Revoke** button, and it bites on the next run: the tool
  holds no cached key and re-derives the record key from the grant every time.

## The flags

```
npm run record:export -- [--patient <account-id> | --url <pasted address> | --all]
                         [--list] [--request <email>]
                         [--client <key>] [--probe] [--dry-run] [--stdout] [--purge]
```

| Flag | What it does |
|---|---|
| *(none)* | Exports the record of the account in `LEXITAR_CLI_EMAIL`, asking for that password on the terminal. The owner path; nothing below applies. |
| `--request <email>` | Asks that person for access and prints what they must do. Files nothing readable. |
| `--list` | Prints the account ids whose records are approved right now, and until when. This is the only list that proves an approval is live. |
| `--patient <account-id>` | Exports that one record. It takes an **account id**, not an address — `--list` prints them. |
| `--url <pasted address>` | Takes what you have in hand: the address bar while looking at that person's record. See below. |
| `--all` | Exports every record currently approved. One unreadable record is skipped with a line on stderr, and the run still exits non-zero. |
| `--probe` | Only with `--url`, and only when the address cannot be resolved without looking. See below. |
| `--client <key>` | Selects one person inside a record that holds several. Rarely needed; `--url` sets it for you. |
| `--dry-run` | Lists what would be exported and writes nothing to disk. |
| `--stdout` | Also prints the structured record to stdout. Off by default because the usual caller is an agent, and a transcript should not become a second copy of the record. |
| `--purge` | Removes every export this tool has written. Reads nothing and needs no credential. |

Examples:

```sh
npm run record:export -- --request alex@example.invalid
npm run record:export -- --list
npm run record:export -- --patient 7f3c… --dry-run
npm run record:export -- --url 'https://literacy.tinytars.foundation/#alex/markers'
npm run record:export -- --all
npm run record:export -- --purge
```

### `--url`, and why it sometimes refuses

The address bar names a person by a short label that means something only *inside* their own record —
`#alex/markers` — not by an account. So the tool resolves it the cheap ways first: if exactly one
record is approved, it is that one; if the label matches an approved account id, it is that one.

If neither holds, the only way to learn whose label it is, is to open each approved record and look —
and every one of those opens is a real disclosure recorded on a person who is **not** the subject of
this export. So the tool refuses, names the candidate account ids, and tells you to pass `--patient`.
`--probe` is the explicit opt-in to look anyway; it says beforehand how many records it is about to
open and on whose screens those rows will appear.

Nothing is cached between runs. A map from labels to owners would itself be a record of which family
members exist, which is exactly what this system protects.

## The weekly renewal, and the order that matters

After seven days the approval has elapsed but its entry is still sitting in the Access panel, and
`--request` against it reports the link it already found — which is **not** proof that it is live.
`--list` is the proof: if the account id is not in it, the approval has lapsed.

The order to renew is:

1. **They press Revoke** on this tool's entry in their Access panel.
2. **Then** re-run `--request`, and they approve the fresh one with 7 days.

Doing it the other way round leaves the stale grant in place until something touches it, and the
first thing that touches it deletes the envelope **and marks the record for re-keying** — so that
person's whole record is re-encrypted at their next sign-in, weekly, for nothing. Revoking first
removes the same envelope without setting that flag. This is the difference between a thirty-second
weekly ritual and a weekly re-encryption.

## Where the files land

`$XDG_STATE_HOME/lexitar/exports/<blobId>-<timestamp>/`, mode 0700, one directory per run, holding
`record.json`, `documents/`, `transcripts/` and `manifest.json`. `LEXI_EXPORT_DIR` overrides the root.

**These are plaintext health records.** They are outside every code checkout on purpose, and the tool
refuses at run time — with no `--force` — to write into a git work tree or under `records/`
(`scripts/export-dir.ts`). An ignore rule is not the control here: this repository is public and its
own ignore file re-includes `records/**`.

Remove them with `npm run record:export -- --purge`, or with the `rm -rf` line every run prints as its
last output. A copy on a computer is a class of copy that deleting an account cannot reach, which is
why the erasure text says so in as many words (`src/lib/erase-account.ts`).

## What sits on disk between runs

One password, in `plover-keys`. No session token and no account key is ever written to disk: every run
signs in fresh, so there is no cached bearer to steal and nothing that outlives a grant.

What that password can do on its own:

- **Read a record nobody approved** — no. Every target comes from the server's own list of live
  grants, and the tool refuses a target that is not in it rather than asking the server, because
  asking is itself the harm.
- **Read a record after the window** — no. Expiry is enforced on the read path, not by the tool.
- **Read a record after Revoke** — no, from the next run.
- **Change a record** — no. A write from this principal is refused by the server.
- **Take over an account** — no. It cannot issue an account-recovery code; the capability belongs to a
  different kind of principal and the route re-checks it.
- **Read without leaving a trace** — no. Every open is a row on the record owner's own access screen,
  and those rows survive account erasure.

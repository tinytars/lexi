# RECOVERY.md — getting a locked-out user back in

> **Corrected 2026-08-25 (W73). This document used to be wrong in the way that matters most.**
>
> It opened with *"nothing is ever locked behind a key you could lose"* and described key loss as an
> impossibility. That was true of the **pilot records committed to this repo** — plaintext in git, which
> is why the history-purge section below still stands. It stopped being true of **user accounts** the day
> W44 shipped envelope encryption, and has been false for every account created since. A reader searching
> this repo for "recovery" found the one document telling them the problem did not exist.
>
> The history-purge section is unchanged and still correct. Everything above it is new.

## Who this is about

Two populations, and they recover in completely different ways.

| | Pilot records in this repo | Accounts created since W44 |
|---|---|---|
| Where the truth is | plaintext `records/private/{id}/vault.json` | R2 ciphertext; the browser holds the key |
| Key loss | impossible — the history-purge section's premise | **real, and sometimes permanent** |
| Recovers by | opening the file | the ladder below |

The rest of this document is about the second column. For the first, the old advice was right and is
unchanged: the plaintext is in the repo, and `npm run vault:build` regenerates every `.enc` from it.

## The rule everything follows from

A password does not unlock the record. It unlocks a **key**, and the key opens the record. So a plain
"reset my password" link returns the *account* and not the *data*: you would sign in successfully and
find the record still sealed.

Email can never open it. If email could, then anyone who reached the mailbox — or the operator — could
read the record, and the central claim in `SECURITY.md` would be false. Apple reached the same place:
under Advanced Data Protection they hold no keys, and they never mail you a recovery key.

## The standard

Held to deliberately, and **enforced by `tests/unit/recovery-invariants.test.ts`** where it can be —
because a standard nobody checks is a wish. This document's own history is the argument for that.

| # | Invariant | Apple's equivalent | Enforced |
|---|---|---|---|
| **I1** | The operator holds no key that opens a vault **online**. No file under `functions/` can load the org private key. | ADP: Apple holds no keys | ✅ static sweep |
| **I2** | Key material is shown, never sent. No email carries a wrapped key, an authHash, or a link that grants access. | The recovery key is displayed, never mailed | ✅ static sweep, **one named deviation** |
| **I3** | Every path ends in something the user controls — a secret they kept, or someone who already has access. Never an operator decision alone. | recovery key / recovery contact | Phase D |
| **I4** | A short secret is accepted only behind a hard server-side attempt cap, one-time use, and an expiry. | HSM escrow: 10 tries, then destroyed | ✅ schema; behaviour in Phase D |
| **I5** | Recovery **replaces** credentials, never silently adds one; it revokes sessions and always notifies. | Apple notifies every device | ✅ rung 1 (Phase C); rung 2 in Phase D |
| **I6** | A recovery method exists before there is data to lose. | ADP cannot be enabled without one | **deviation** |

### The two deviations, named so they cannot drift into accidents

- **I2 — no deviation after all.** An earlier draft of this milestone was going to let a clinician email
  the code. Building it surfaced why that is not a small trade: **for the server to put the code in an
  email, the server must be given the code**, and it already holds `wrapped_dek`. Anything holding both
  can open the record — so an emailed code would not be "a key in a mailbox", it would be the operator
  transiently able to read a patient's record. That is I1 and the central claim, not I2. There is no
  clean workaround: splitting the code so the server learns only half still requires the clinician to
  speak the other half. **Decided 2026-08-25: spoken delivery only**, which also makes the identity check
  structural — the code cannot reach the patient without the conversation happening.
- **I6** — Apple *requires* a recovery method before end-to-end encryption can be switched on. Here
  minting stays **on-demand** (owner decision), with the nudge re-enabled so the choice is at least
  informed. This is the deviation most likely to hurt someone, and it is stated first for that reason.

## Why a clinician, and why not a family member

A clinician with a live grant **already holds the record's key** — that is what provider access *is*.
Asking them to issue a recovery code gives them nothing they did not already have, which is the whole
reason they are eligible.

Apple's recovery contact cannot read your data. Ours necessarily can, because re-wrapping the key
requires having it. So the eligible set is exactly *people who already have access*, and nominating an
arbitrary family member is **not** offered: it would silently hand them the record. That asymmetry with
Apple is real and is stated rather than glossed.

**The cost, stated plainly:** this turns a clinician's *read* access into the ability to *reset the
account*. It is recorded in `SECURITY.md` under Deliberate non-goals, not in a footnote.

## What each side actually does

**The patient**, on the lock screen: *Forgot password?* → one recovery-code form, with one field for
the code. There is nothing to pick: which rung it redeems is read off the code's own shape — a
self-service code is always 20 characters, a provider-issued one always 12 (shown grouped
`XXXX-XXXX-XXXX`), and the two lengths never collide. Both rungs are still named on the **first**
screen, so someone who will need their clinician learns that before choosing a password rather than
after. Either rung ends with them entering a code and a new password together, and then signing in
through the ordinary form — recovery leaves behind no special-case login path.

**The clinician**, on the roster they already use: a **Recovery code** button on the patient's row. It
shows the code once and tells them, in the dialog, that *they* are the identity check — call the number
you already have, because this code lets whoever holds it reset the account. The code is never emailed,
so the conversation is not a policy anyone can skip.

Rung 2 mints a **new account keypair**, so the patient's old password, passkey and Google sign-in all
stop working, and the vault is flagged for a DEK rotation. Rung 1 only re-wraps the existing key, so
those keep working. The lock screen reads the pasted/typed code live and shows which applies before
the user commits — there is no separate step where they have to say which one they're holding.

## The ladder

Most self-service first. The UI offers the next rung only when the one above is unavailable.

| | The user has | Who else is involved | Status |
|---|---|---|---|
| **0** | a passkey | nobody | works today; poorly surfaced |
| **1** | their recovery code | nobody | ✅ W73 Phase C — redemption now sets a new password |
| **2** | neither, but a clinician with live access | that clinician | ✅ W73 Phase D |
| **3** | none of the above | an operator, offline | ✅ W73 Phase E |

**Rung 3, the operator's last resort.** `npm run recovery:approve -- --email <patient>` reads the org
recovery envelope, unwraps the DEK with the org private key, and writes **the same grant row a clinician
writes** — so the patient's side is the identical screen and the identical code. There is no
operator-only redemption path to get wrong, and `tests/unit/recovery-approve.test.ts` asserts the route
accepts what the CLI produces, because the failure mode otherwise surfaces on a phone call with someone
who has no other route left.

It requires `ORG_KEY_PASSPHRASE`, it targets **the database of the worktree you run it in** (so a prod
operation from the dev worktree hits dev — wrong in the safe direction), it prints what it is about to
do and refuses to act without `--confirm`, and it records itself in the patient's own access events as
the ORG account rather than as a clinician.

**A patient who revoked org recovery cannot be helped by anyone, including us**, and the script refuses
rather than offering a `--force`. That revocation is the one lever a patient has to say "not even the
operator"; honouring it is the entire value of offering it. If it ever grows an override, the checkbox
in the UI has been lying.

---

## History purge — expunging a mis-ingested (wrong-patient) file

`npm run ingest -- --client X --remove-source <id|file>` (W13h) cleans the **working tree, the
served `.enc`, and R2** immediately: it deletes the raw + processed files, drops the `SourceRecord`
and every reading/disease that source produced (corroborated readings survive), writes a PHI-free
tombstone to `vault.removedSources[]`, and deletes the R2 raw/processed objects.

**But the raw bytes (and the vault diffs that contained the wrong patient's readings) remain in git
history** until the history is rewritten. For an ordinary correction in this private repo that is
fine. For a **sensitive removal** — a file belonging to the wrong patient, ingested by mistake —
plaintext PHI cannot be "rotated"; it must be **expunged from history**.

### Procedure (git filter-repo)

> Requires [`git-filter-repo`](https://github.com/newren/git-filter-repo) (`brew install git-filter-repo`).
> This rewrites history and changes commit hashes — coordinate before running on a shared branch.

1. **Run the logical removal first** so the working tree, `.enc`, and R2 are already clean:

   ```bash
   cd apps/health-dash-web
   PASSPHRASE=<vault-passphrase> npm run ingest -- --client <id> --remove-source <sourceId|filename>
   git commit -am "health-dashboard: remove mis-ingested source <sha8>"
   ```

2. **Identify every path that ever held the bytes.** The raw original is one path; the plaintext
   `vault.json` and the served `.enc` also carried the readings in their blobs. The raw file is the
   only one holding the *document*; the vault blobs held *extracted values*. For a true wrong-patient
   expunge, purge the raw file path from history:

   ```bash
   git log --oneline --all -- 'apps/health-dash-web/records/private/<id>/raw/<stored-filename>'
   ```

3. **Purge the raw file path from all history:**

   ```bash
   # from the repo root
   git filter-repo --invert-paths \
     --path 'apps/health-dash-web/records/private/<id>/raw/<stored-filename>' \
     --path 'apps/health-dash-web/records/private/<id>/processed/<sha8>.json'
   ```

   The extracted values also live inside historical `vault.json` / `data-<id>.enc` blob *revisions*.
   If the wrong-patient data must not survive in any historical blob, the conservative move is to
   purge those paths' history too and re-commit the current (clean) versions — accepting that you
   lose the in-repo history of those two files:

   ```bash
   git filter-repo --invert-paths \
     --path 'apps/health-dash-web/records/private/<id>/vault.json' \
     --path "apps/health-dash-web/records/public/data-<id>.enc"
   # then restore the current clean copies from your working tree and commit
   ```

4. **Force-push the rewritten history** (this is the one sanctioned `--force`, and only here):

   ```bash
   git push --force origin <branch>
   ```

5. **Invalidate the R2 copy** if it was ever public-readable and re-upload the clean blob:

   ```bash
   npm run vault:build && # then push via the headless wrangler flow (AUTH.md)
   ```

6. **If the repo was ever public** while the file was present, treat the bytes as disclosed: the
   purge removes them going forward but cannot un-disclose. Follow the project `CLAUDE.md`
   visibility-flip rule (rotate every committed credential; purge `records/private/`).

### Why removal ≠ history purge

`--remove-source` is the everyday tool — it makes the data *gone* from every live surface and proves
it via the tombstone + `vault:verify` provenance check. The history purge is the rare, heavier
operation reserved for genuinely sensitive mis-ingestion, because it rewrites shared history.

## Rebuilding the machine, not the data

Everything above assumes a working checkout. If the machine itself is gone, the from-zero
runbook is `BOOTSTRAP.md` in `pablo-tech/plover-context` (cloned to `~/.claude`), and
`bash ~/.claude/scripts/doctor.sh` verifies a rebuilt machine before you trust it with a
vault operation.

Two things there bear on recovery specifically: the vault passphrases live in
`plover-context`'s `infra/cloud/credentials/health-dash.env`, not in this repo — so a
checkout alone cannot decrypt anything — and `vault:verify` in CI needs the self-hosted
runner, which is registered per machine and is not restored by cloning.

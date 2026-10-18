# Credentials

Every secret this application reads, where each one belongs, and what a clone can do with none of
them. One document, because the alternative is a reader assembling the answer out of
`.dev.vars.example`, `wrangler.jsonc`, a `.gitignore` and seven script headers.

**Start here if you have just cloned this.** You need no credential to build it, run the unit suite,
run the end-to-end suite or stand up a local database — see [What runs with nothing
configured](#what-runs-with-nothing-configured), which is a measurement rather than an aspiration.
What you need a credential for is inference, the three third-party sign-in paths, and the operator
commands that reach a deployed store. [Standing this up from a
clone](#standing-this-up-from-a-clone) is the path through those, and `npm run doctor` is what tells
you where you are on it.

## Standing this up from a clone

**The shortest path to a running app you can sign in to is one secret.** `SESSION_SECRET` is the
only thing password sign-in needs; `npm run support:provision` then gives you a local account to be.
Everything else buys a feature, and the table below says which half of the setup cost each one is in.

Seven of the nineteen route secrets both deployed environments carry you mint yourself in a
terminal. The other twelve need an account somewhere, and four separate providers between them —
which is the real setup cost of this application and is worth knowing before you start rather than
four commands in.

| Secret | Where it comes from |
|---|---|
| `SESSION_SECRET` | `openssl rand -base64 48`. Any long random string; nothing else holds a copy, and changing it signs everyone out |
| `VAULT_TOKEN` | `npm run allowlist`, which prints the comma-joined bearer hashes to paste in. Needed only to write a blob from a terminal |
| `PROVIDER_TOKEN` | `openssl rand -base64 32`. The bearer handed to a proven clinician |
| `GOOGLE_KEK` | `openssl rand -base64 32`, **once, ever** — it is the only holder of every Google-only account's wrapped private key, so re-minting it is a permanent lockout and not a rotation. See [Rotation](#rotation) |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN` | your own hostname. Not secret, and the local values are already in the template. `RP_ID` is the bare domain, `ORIGIN` the exact scheme+host(+port) the browser sends |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com). `FINDING_ANTHROPIC_API_KEY` and `RANGES_ANTHROPIC_API_KEY` are separate keys **on the same account**, so one feature cannot exhaust another's budget; both fall back to this one, so start with one key |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | a **Web** OAuth client in the Google Cloud console — see the three redirect URIs below, which is the step that actually catches people |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | an Azure Cognitive Services **Speech** resource. The region is the short id (`eastus`), which becomes the hostname at `functions/api/speak.ts:40` — not a URL |
| `GMAIL_SA_CLIENT_EMAIL`, `GMAIL_SA_PRIVATE_KEY`, `GMAIL_SENDER` | a Google Cloud **service account** with domain-wide delegation on a domain you control, delegated to impersonate `GMAIL_SENDER`. The heaviest item here, and it buys one notice email |
| `CLIENT_ERROR_GITHUB_TOKEN`, `CLIENT_ERROR_GITHUB_REPO` | a fine-grained GitHub PAT scoped to one repository, Issues read/write only |

`EMAIL_FROM` is deliberately absent from both this table and the template: it is optional and
defaults to `TinyTars <GMAIL_SENDER>` at `functions/_lib/email.ts:107`, so a line for it would read
as something you must fill in.

**Google sign-in needs three authorized redirect URIs, not one.** `start.ts:40` builds the URI from
`url.origin` — the host the browser actually reached — so every host that serves the app needs its
own entry, each `https://<host>/api/auth/google/callback`. Measured live on 2026-10-08, each
answering `302` with its own `redirect_uri`:

| Host | Cloudflare Pages project | Branch |
|---|---|---|
| `health-dash-aex.pages.dev` | `health-dash-dev` | `dev` |
| `health-dash-prod.pages.dev` | `health-dash-main` | `main` |
| `literacy.tinytars.foundation` | `health-dash-main` (custom domain) | `main` |

Neither project's `.pages.dev` hostname contains its project name, which is the trap: `health-dash-dev`
serves `health-dash-aex`, and `health-dash-main` serves `health-dash-prod`. Add `http://localhost:8788`
for local development. A missing entry fails as Google's own `redirect_uri_mismatch`, which names the
URI it was sent and not the one you forgot to register.

**That `302` is not evidence the URI is registered, and checking it is the one that catches this.**
A `302` out of `/api/auth/google/start` proves only that `GOOGLE_CLIENT_ID` is set — `start.ts:33-36`
answers `503` when it is not — and it is produced entirely by this app, which has no idea what
Google will accept. Only Google knows. So follow the `302` to its `Location` and read the body that
comes back: an unregistered URI returns a page containing `redirect_uri_mismatch`, and a registered
one returns the account chooser. Every host in the table above is worth checking that way after any
change to the client, because a host can answer `302` correctly for months while the one entry it
needs has never existed.

**Preview deployments deliberately carry no secrets, and that is a property rather than a gap.**
Measured on both projects, 2026-10-08: the `preview` environment holds the two plain variables and
**zero** secrets, against 19 in `production`. A preview build is reachable by URL by anyone who has
the URL, so it gets no key — which is why a per-deployment preview URL answers a bare 503 on
`/api/auth/google/start` (`start.ts:33-36`). That 503 is the design working. `npm run doctor` fails
if a secret ever appears there.

## Preflight

**`npm run doctor`** (`scripts/check-env.sh`) is the one command to run when something "just doesn't
work", and the first one to run on a new machine. It asks every environmental question at once
rather than failing on the first, and it exits non-zero only on a real fault — a clone with no
credential store warns and passes, because that is the ordinary state of this tree:

- Node on `PATH`, and `NODE_EXTRA_CA_CERTS` readable if set at all (Node ≥18 throws at startup on an
  unreadable one, before any of this code runs, with an error naming neither TLS nor the variable)
- `.dev.vars` present, and which stores hold `cloudflare.env` and `org-key.json`
- zero-byte `records/**/vault.json` — which `vault:verify` reports as corrupted JSON on a file that
  was fine a moment ago, and which `git checkout --` recovers because it is a committed fixture
- **every secret the code reads is provisioned on the environment you are pointed at.** The required
  set is derived, not listed: every `env.NAME` under `functions/` plus every `keyEnv` in
  `inference.config.json`, which is the only place the three model keys appear at all. Add
  `env.NEW_SECRET` to a route and it is required from that commit with nobody having edited the
  preflight — so an unprovisioned secret fails here instead of 500ing one route in production
- the reverse direction too: a name provisioned that nothing in this tree reads **warns as stale**,
  because a live credential with no reader is exposure with no counterpart in capability
- `STORE_PREFIX` agrees between the checkout and the project, and `preview` carries no secrets
- backup freshness, via `npm run vault:snapshot:check` (`BACKUP.md`)

**`npm run doctor:prod`** asks the same of the production project, whose name it reads from
`origin/main`'s `wrangler.jsonc` rather than from a literal — that file is deliberately divergent
between the two branches (`wrangler.jsonc:3-5`), so `main`'s copy *is* production's definition.

## The two placements, and which is which

A secret here is one of exactly two things, and the difference is not cosmetic — it decides where the
value lives, who sets it and what happens when it is absent.

**A route secret** is read by a Cloudflare Pages Function at request time, as a property of its `env`
binding. In production it is set with `wrangler pages secret put <NAME>`; locally it goes in
`.dev.vars`, which is gitignored (`.gitignore:20`) and whose template is
[`.dev.vars.example`](.dev.vars.example). A route secret is never read from a file in the repository
and never from the operator's machine.

**An operator artifact** is read by a script run from a terminal, out of a private credential store
— a separate private repository, never this one. `scripts/creds-dir.ts` resolves it and
`scripts/load-creds.ts` is the loader: it reads `health-dash.env`, `gcp-oauth.env`, `cloudflare.env`
and `anthropic.env`, surfaces every key it finds, and never overwrites a variable already set in the
environment. It is deliberately generic, so adding a key to one of those files needs no code change
here.

**There are two stores since 2026-10-08, and a file is looked up in each in turn.**
`LEXI_CREDENTIALS_DIR` is LexiTar's own store (`tinytars/lexi-keys`, default `~/PabloTech/lexi-keys`)
and `PLOVER_CREDENTIALS_DIR` is the estate's shared one (`promontory-studio/plover-keys`, default
`~/PabloTech/plover-keys`). They hold **different files**, not two copies of the same ones — this
product's org key, Google client and account logs in the first; the account-wide Cloudflare token and
the shared model key in the second — which is why the lookup is per file rather than one directory
chosen once at startup. A write lands in the first.

**A cloner sets one variable.** Point `LEXI_CREDENTIALS_DIR` at your own private store and you have
one store, because the second is only ever consulted on a miss. Nothing is special-cased for either
arrangement, and `scripts/creds.sh` is the deliberate bash duplicate of the same order — a shell
script cannot import TypeScript, and this document is what holds the two to each other.

**Nothing is in both.** A value that is needed by a route and by a script is stored once, in the
store, and set into Pages separately; the store's PROD-prefixed entries are that second copy, named
so a reader cannot mistake which one a Function reads.

## Route secrets

Set each in Pages for a deployed environment, or in `.dev.vars` for `wrangler pages dev`. "Clone
needs it" answers whether someone who is not the operator has to obtain one to work on this code.

| Name | What needs it | What breaks without it | Clone needs it |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | every AI feature, through `inference.config.json`'s `keyEnv` | each inference route answers `model for "<feature>" is not configured` (`functions/_lib/inference/resolve.ts:35`); nothing else is affected | no |
| `FINDING_ANTHROPIC_API_KEY` | Finding regeneration alone, so it cannot exhaust the chat key's budget | nothing — it falls back to `ANTHROPIC_API_KEY` | no |
| `RANGES_ANTHROPIC_API_KEY` | ranges, document extract and leaf regeneration, for the same reason | nothing — same fallback | no |
| `SESSION_SECRET` | the session cookie's HMAC (`functions/_lib/session.ts`) | nobody can sign in, so every authenticated route 401s | no — the e2e suite sets a throwaway |
| `VAULT_TOKEN` | the `/api/vault` write allow-list, as the comma-joined bearer hashes `npm run allowlist` prints | `scripts/vault-sync.ts` cannot write a blob; the browser path is unaffected, being session-gated | no |
| `PROVIDER_TOKEN` | `/api/refresh-finding`, `/api/refresh-range`, `/api/log`, `/api/logs` | a proven clinician cannot regenerate a Finding | no |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN` | passkey registration and assertion (`functions/_lib/webauthn.ts`) | passkey enrolment and passkey sign-in fail; password and recovery sign-in still work | no — not secret, and the local values are in the template |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | the Google sign-in exchange (`functions/api/auth/google/`) | Google sign-in fails; the other methods are unaffected | no |
| `GOOGLE_KEK` | the server-held key that wraps a Google account's private key | **every Google-only account is locked out, permanently.** This one is not rotatable in the ordinary sense — see [Rotation](#rotation) | no |
| `GMAIL_SA_CLIENT_EMAIL`, `GMAIL_SA_PRIVATE_KEY`, `GMAIL_SENDER`, `EMAIL_FROM` | the support-access notice mail (`functions/_lib/email.ts`) | a support grant is still recorded and still audited; the patient is not emailed about it | no |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | `/api/speak` | read-aloud returns an error; nothing else | no |
| `CLIENT_ERROR_GITHUB_TOKEN`, `CLIENT_ERROR_GITHUB_REPO` | filing an uncaught browser or Function error as an issue | reports go to `wrangler pages deployment tail` only, which is the documented fallback | no |

**The three `GOOGLE_*` values live in `gcp-oauth.env`, and that file is the live one.** A second,
stale copy sits in `health-dash-web.dev.vars`, beside it in the same store since the 2026-10-08
split moved both out of the estate's; it was named in no inventory here until that day, and
`load-creds.ts` does not read it at all. Which is live was settled by measurement rather than by
reading either file: `/api/auth/google/start` answers `302` on both deployed hosts carrying
`client_id=524960690998-…`, and only `gcp-oauth.env` holds that id. If the two ever disagree
again, ask the live 302 — it cannot be out of date.

`GOOGLE_AUTH_URL` and `GOOGLE_TOKEN_URL` are read by the same two routes and are **not** secrets:
they exist so a test can point the exchange at a local stub. Leave them unset in every real
environment.

## Operator artifacts

Read out of a credential store by scripts, never by a route — `$LEXI_CREDENTIALS_DIR` first and
`$PLOVER_CREDENTIALS_DIR` on a miss, per the two-store rule above. None of these is needed to
develop; all of them are needed to operate a deployed store.

| Name | Where it lives | What needs it | What breaks without it |
|---|---|---|---|
| `org-key.json` | the store's root | every `vault:*` command — it is the operational keypair whose public half holds a recovery envelope on each vault, and whose private half is the only operator path into one | no vault can be opened from a terminal at all |
| `ORG_KEY_PASSPHRASE` | `health-dash.env` | unwrapping the above (`scripts/org-key.ts`). **Not an Actions secret, measured 2026-10-07** — no org key file reaches a hosted runner (`scripts/org-key.ts:28` resolves `ORG_KEY_PATH` or the store with no fallback, and no workflow sets either), so a copy in CI has no counterpart there and opens nothing; `.github/workflows/ops.yml` records which five ops are operator-only for that reason | the same, with a clearer error |
| `ORG_KEY_PATH` | not stored — set by hand | an override naming one key file outright | nothing. It exists for a key rotation, where the old key and the new one must both be loadable in one run, and that is its only supported use |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `cloudflare.env` | `scripts/wrangler.sh` and the snapshot/restore tooling, which talks to the R2 REST API directly | no snapshot, no restore, no deploy from a terminal |
| `ANTHROPIC_API_KEY` | `anthropic.env` | the measurement and bench scripts, which resolve it the same way a route does | those scripts refuse with the message above |
| `LEXITAR_SUPPORT_EMAIL`, `LEXITAR_SUPPORT_PASSWORD` | `health-dash.env` | `scripts/api-session.ts` presenting a support principal | support-side CLI access fails |
| `gmail-sa.lexitar.json` | the store's root | the service account behind the notice mail above | as the `GMAIL_SA_*` row |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | not stored — a service token, set per session | `scripts/api-session.ts:118-119` getting a terminal through the Cloudflare Access wall that fronts a deployed origin (`API.md`) | `assertNotAccessWall` (`:168-175`) throws naming both variables, because the bare symptom is an HTML login page being parsed as JSON |

**`LEXITAR_CLI_EMAIL` and `LEXITAR_CLI_PASSWORD` are deliberately not in the store, and that is a
rule rather than an omission.** An account's password is also the key-encryption key that opens that
account's record, so writing it anywhere is writing down the record's key.
`scripts/api-session.ts` asks for it on the terminal, and `scripts/load-creds.ts:16-19` records why
it is excluded from the loader. `LEXITAR_SUPPORT_*` is loaded and is not a softening of the same
rule: a support principal owns no record, so its password is a key-encryption key for nothing.

## Measured dead, 2026-10-06

Six names in the credential store are read by **nothing** in this repository. Swept across `src`,
`functions`, `scripts`, `server` and `tests`, word-boundary matched, comments excluded: zero hits
each. They are listed because an inventory that quietly omits what it found is the document going
stale on the day it was written, and because a secret handed to a job that reads it for nothing is
exposure with no counterpart in capability.

| Name | What it used to open |
|---|---|
| `PASSPHRASE` | the provider login that `migrations/0002` seeded, until that migration was rewritten to seed no credential at all |
| `SEED_PASSPHRASE` | nothing that survives — it has no reader and no documented job |
| `ROSTER_PASS` | `records/roster.enc`, which no code path has read since the W44 cutover and which this repository no longer tracks |
| `PROD_CHAT_TOKEN` | the `CHAT_TOKEN` Pages secret, deleted 2026-08-26 |
| `PROD_RAW_TOKEN` | the `RAW_TOKEN` Pages secret, deleted the same day |
| `PROD_PROVIDER_UNLOCK_TOKEN` | nothing — the name appears nowhere in this tree |

The first three were passed into the scheduled snapshot job and into the dispatchable ops action;
both wirings are removed. **The values themselves are not destroyed**: they remain in the credential
store as the passphrase of historical artifacts, which is the only thing they are still good for.
Deleting the repository secrets that hold copies of them is a separate, outward-facing decision and
is the operator's.

## Configuration that is not a secret

These shape where a command points and are set in `wrangler.jsonc`, in CI, or on the command line.
None belongs in `.dev.vars` and none belongs in the store. The complete list is not here on purpose —
each is documented where it is read — but the ones most often mistaken for secrets are:

- `STORE_PREFIX`, `VAULT_BUCKET`, `D1_DATABASE` — which store a command acts on. **`STORE_PREFIX`
  alone does not decide it**: `scripts/target.ts` reads the checkout's `wrangler.jsonc` for the
  bucket and the database and takes only the key prefix from the environment, so the two overrides
  are set together or not at all. `describeTarget()` prints the answer before anything remote is
  touched, and reading it is the cheap way not to act on the wrong store.
- `LEXI_CREDENTIALS_DIR`, `PLOVER_CREDENTIALS_DIR` — where the two stores are. Paths, not secrets.
- `LEXI_DATA_DIR`, `LEXI_DIST_DIR`, `LEXI_EXPORT_DIR`, `PORT`, `XDG_STATE_HOME` — local paths and ports.
- `INFERENCE_MODE`, `ORG_ACCESS_LOG`, `CANARY_MAX_AGE_H`, `E2E_WORKERS` — operational knobs.
- `PLOVER_ALLOW_LOCAL_VAULT_WRITE` — a safety override, not a credential. It permits a store write
  from a workstation rather than through the ops workflow, prints a warning when set, and exists for
  an emergency (`scripts/vault-sync.ts:145-161`).

## What runs with nothing configured

Measured on 2026-10-08 with **both** `LEXI_CREDENTIALS_DIR` and `PLOVER_CREDENTIALS_DIR` pointed at
empty directories — the state of a fresh clone, and the reason the numbers are here rather than the
claim:

- **The unit suite passes in full** — 334 files, 3,758 tests, `npx vitest run`. No credential,
  no store, no network.
- **The end-to-end suite passes.** Every spec provisions its own world: per-worker synthetic
  patients (`tests/e2e/_synthetic.ts`), a local-only clinician and a local-only support account
  (`scripts/provision-e2e-patient.ts`, `scripts/provision-support-account.ts`). The literal
  passwords those two use are in the scripts, in plain sight, because they are local-only and
  destroyed with the database each boot — which is also why both files are named in
  `.protocol/credentials-allow-content` rather than exempted by a pattern.
- **A local database builds from scratch** — `npm run d1:migrate:local` applies every migration to a
  fresh local D1. `migrations/0002` seeds four synthetic principals and no key material of any kind:
  no credential row, so there is nothing to sign in as, which is deliberate. A loginable local
  account comes from `provision-support-account.ts` and a local vault from
  `provision-e2e-patient.ts`.
- **The type-checker and the linter are clean** — `npm run check`, `npm run lint`.
- **`npm run doctor` exits 0**, warning that no store holds `cloudflare.env` and naming exactly what
  that blocks — every remote wrangler command, snapshots, restores and the deployed-environment
  checks — and exactly what it does not.

What is left needing a real value: chat and every other inference feature, passkey enrolment, Google
sign-in, provider-token routes, read-aloud, notice mail, and every `vault:*` operator command. That
is the whole of it.

## How the tree refuses a secret

Four mechanisms, and only the last two survive someone who means it.

1. **`.gitignore` refuses the paths a secret arrives on.** `.dev.vars` (`:20`), `.cloudflare.env`
   (`:24`), the global plaintext bans (`:36-41`), `records/*` with only the served static layer
   re-included (`:54-55`), and the atomic-write temp files a `records/` re-inclusion would otherwise
   leave stageable (`:71`) — that last one is there because exactly such a file was found holding a
   full copy of a record, untracked and un-ignored, on 2026-08-11.
2. **`scripts/export-dir.ts` refuses at run time** any export destination inside a git work tree or
   under `records/`. An ignore rule binds only the checkout that carries it; an export lands wherever
   `--out` points, so the control has to be in the code.
3. **The protocol's credentials guard runs on every commit**, from `.githooks/pre-commit`. It reads
   three content shapes — an issuer-prefixed key or token, a `NAME=value` assignment of a
   live-looking value, and **a wrapped key beside the parameters needed to unwrap it** — plus a
   path-name rule for `*.env`, `*.pem`, `*.key`, `*.enc`, `*.dev.vars` and friends. Its default is
   the strict one: the two policy files below only ever *relax* it, so an absent or empty one
   exempts nothing.
   - `.protocol/credentials-allow-name` — paths whose *name* has a credential shape and whose
     content is innocent. **Deliberately empty**, and it says so: no path here qualifies.
   - `.protocol/credentials-allow-content` — paths whose *content* legitimately carries a credential
     shape. Seven entries, each a literal path and never a glob, each read before it was added, each
     with its justification on the line above it. A glob would exempt every suite written from here
     on, including the one that accidentally pastes a real key, and would never announce itself.
4. **CI runs the same guard over the whole working tree** (`.github/workflows/ci.yml`'s
   `credentials` job, `--scan-tree`). This is the half pre-commit structurally cannot do: pre-commit
   judges the staged set, so a secret already committed is invisible to it forever. That gap is not
   hypothetical — it is how a wrapped private key sat in this repository for twenty-two days with a
   guard installed that would have refused it on the way in.

`bash ~/.claude/scripts/doctor.sh` asks the standing form of the same question, once per declared
repository: whether a repository holds anything its own credentials policy refuses, judging the
upstream ref rather than whatever branch a checkout happens to sit on.

## Rotation

**A secret that has been exposed is replaced, not moved.** Moving it to a better home leaves every
copy already taken exactly as valid as it was; only a new value ends the exposure. This is the rule
that governs everything above, and it is written here rather than inferred because this repository
learned it the expensive way: `migrations/0002` published a wrapped account private key next to its
own unwrapping parameter, on a public branch, for twenty-two days. Re-keying is what closed that.
Deleting the file would not have.

Three consequences worth stating:

- **An asymmetric key is replaced by generating a new pair and re-wrapping what it protected**, not
  by changing its passphrase. `scripts/rotate-pilot-credentials.ts` re-derives a new
  key-encryption key over the **same** private key and deliberately leaves the data-encryption-key
  envelopes untouched — which is the right behaviour for a forgotten password and no remedy at all
  for a published key. Mistaking one for the other is the trap; the file's own header says so.
- **`GOOGLE_KEK` is the exception that proves the rule.** It wraps every Google-only account's
  private key, and nothing else holds a copy, so rotating it without re-wrapping each account first
  is a permanent lockout rather than a rotation. Treat it as data, not as a password.
- **A credential's home is part of its rotation.** Anything in the operator's credential store is
  covered by that repository's own rule — if its visibility ever changes, every value in it is
  rotated immediately — which is a guarantee a value sitting in a public application repository
  cannot be given at all.

## See also

- [`AUTH.md`](AUTH.md) — accounts, credential methods, and what each one wraps.
- [`VAULT.md`](VAULT.md) — the storage and encryption model, and the operator-read conditions.
- [`.dev.vars.example`](.dev.vars.example) — the template for the route secrets above, with the
  per-secret commentary this table summarises.
- [`BACKUP.md`](BACKUP.md) — snapshot and restore, which is what the Cloudflare pair is for.
- `scripts/check-env.sh` — the preflight this document's claims are checked by on every run of
  `npm run doctor`, rather than only on the day they were measured.
- **The worked private example: `tinytars/lexi-keys`' own `README.md`.** This document is the half a
  cloner can read, and it deliberately stops at the shape — a private store's inventory names real
  files and real provenance dates, so it cannot live in a public repository. That README is the same
  shape filled in: one row per file, column 2 naming the variables it sets, what the value opens,
  where else the same value is set, how to rotate it and the blast radius if it leaks, column 3 a
  status. If you are standing up your own deployment, copy that shape rather than inventing one —
  and copy the rule it states about itself, which is that **an inventory nobody maintains is worse
  than none, because it reads as complete.**

# AUTH.md — setting the chat API keys

The `/api/chat` Pages Function needs **two secrets** to work in production. Until both are set,
the chat panel returns **`unauthorized`** (or `chat backend error`). This is the step-by-step
runbook to set them. For the API itself see `API.md`.

## The secrets

| Secret | What it is | Set to |
|---|---|---|
| `ANTHROPIC_API_KEY` | The key the Function uses to call Claude. | A **distinct** Anthropic key — separate budget from the CLI pipeline's key, so web chat can't drain the Finding's credits. |

How auth works: `/api/chat` and `/api/raw` are gated by the `hd_session` cookie (`requireSession`),
and `/api/raw` additionally authorises per record (`rawAccessFor`) — authenticated is not
authorised. Only `PROVIDER_TOKEN` and `VAULT_TOKEN` still reach `requireBearer`
(`_lib/guard.ts:31`). (Full detail in `API.md` → Authentication.)

> **Deleted 2026-08-26: `CHAT_TOKEN`, `RAW_TOKEN`, `PROVIDER_UNLOCK_TOKEN`.** They were bearer
> allowlists for routes that moved to session auth, and had been set on both Pages projects but read
> by no Function. The runbook steps below that provisioned them are kept only as history — do not
> run them. `npm run allowlist` (`scripts/chat-allowlist.ts`) is **still needed** — it generates the
> `VAULT_TOKEN` value, the one bearer allowlist a Function still checks (`vault/[id].ts:73,155`).

### More secrets

Set the same way (`npx wrangler pages secret put <NAME>`), then redeploy (Step 4). The complete
list of secret **names** also lives in `.dev.vars.example` (copy it to `.dev.vars` for local dev).

| Secret | What it is |
|---|---|
| `VAULT_TOKEN` | Bearer allowlist for `PUT /api/vault` (the ops write path). |
| `FINDING_ANTHROPIC_API_KEY` | A **distinct** Anthropic key for the money-spending Finding refresh, so it can't drain the chat key's budget. |
| `RANGES_ANTHROPIC_API_KEY` | A **distinct** Anthropic key for the provider-only `/api/refresh-range` Ranges refresh, isolating its spend from the Finding/chat pools. |
| `PROVIDER_TOKEN` | The distinct secret handed to a proven **clinician** that authorizes `/api/refresh-finding` (and `/api/refresh-range`). |
| `SESSION_SECRET` | HMAC-SHA256 signing key for the `hd_session` cookie (`functions/_lib/session.ts`). A long random value. |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGIN` | Passkey relying-party identity. In prod: the bare domain / app name / exact `https://…` origin. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | **Deferred** — only when Google OAuth ships. |

```bash
# Example — set the session + passkey secrets, then redeploy:
npm run wrangler -- pages secret put SESSION_SECRET      # paste a long random value
npm run wrangler -- pages secret put WEBAUTHN_RP_ID      # e.g. health-dash-aex.pages.dev
npm run wrangler -- pages secret put WEBAUTHN_ORIGIN     # e.g. https://health-dash-aex.pages.dev
```

## Per-environment secrets

There are two deployed environments — `health-dash-dev` (branch `dev`) and `health-dash-main`
(branch `main`) — and **they do not share a single secret**. Every var except `STORE_PREFIX` is
`secret_text`, which the Cloudflare API returns **masked by design**, so prod's set could not be
copied from dev's even if that were wanted; each was provisioned from its own source.

| Var | Where prod's value comes from |
|---|---|
| `ANTHROPIC_API_KEY`, `FINDING_ANTHROPIC_API_KEY`, `RANGES_ANTHROPIC_API_KEY` | The operator's private credential store (outside this repo). **Known compromise:** all three currently hold the *same* key, so the budget isolation the code is designed for (`refresh-finding.ts:54`, `refresh-range.ts:89`) is not real on prod yet — a runaway Finding regeneration can drain the chat pool. Split into three keys when spend justifies it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_KEK` | The operator's private credential store |
| `GMAIL_SA_CLIENT_EMAIL`, `GMAIL_SA_PRIVATE_KEY` | The operator's private credential store (a service-account JSON's `.client_email` / `.private_key`) |
| `GMAIL_SENDER` | The impersonated Workspace mailbox; not derivable from the SA key |
| `SESSION_SECRET`, `PROVIDER_TOKEN`, `VAULT_TOKEN` | **Minted fresh for prod** and recorded in the operator's private credential store. That record is the only copy — the API will never read them back. |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` | The **prod hostname**, `literacy.tinytars.foundation` / `https://literacy.tinytars.foundation` |
| `WEBAUTHN_RP_NAME` | `LexiTar` (same on both) |
| `STORE_PREFIX` | `wrangler.jsonc` on each branch — see below |

**`CHAT_TOKEN`, `RAW_TOKEN` and `PROVIDER_UNLOCK_TOKEN` were deleted from both projects
2026-08-26.** No Function read any of them — `/api/chat` and `/api/raw` moved to session auth, and
only `PROVIDER_TOKEN` and `VAULT_TOKEN` still reach `requireBearer` (`_lib/guard.ts:31`). They had
been kept provisioned so the two environments stayed diffable, which is a poor trade for a live
credential with no owner. `check-env.sh` no longer allowlists them: if one is re-provisioned by
hand it now warns as stale.

**The one thing no automated check can prove: `WEBAUTHN_RP_ID`.** Passkey credentials are bound to
the RP ID they were registered under (`_lib/webauthn.ts:90,116`), so pointing prod at dev's value
silently breaks every passkey — and the value is masked, so nothing can read it back. Two
consequences worth stating plainly:

- Prod's `WEBAUTHN_RP_ID` is set to `literacy.tinytars.foundation`, which is **not yet bound** to the
  project (the zone is not on Cloudflare). Until it is, passkey registration on prod will fail — this
  is intended, and preferable to minting passkeys against a `pages.dev` host that would all have to
  be re-registered later.
- **Beta users' existing passkeys will not survive the cutover.** They were registered against
  `health-dash-aex.pages.dev`; the D1 copy brings their `credentials` rows to a host they were never
  scoped to. Plan for password/Google sign-in at cutover and passkey **re-registration** afterwards.

Verify an environment with `npm run doctor` (this branch's project) or `npm run doctor:prod`. It
derives the required set from the code — every `env.FOO` in `functions/` — so a newly-introduced
secret that was never provisioned on prod fails there rather than as a 500 on one route.

> **Planned:** these values should be visible and editable by an admin user in the admin
> console, not set in stone at provisioning time. Today every change is a `wrangler pages secret put`
> plus a redeploy, and the only record of the minted values is one file on one laptop.

## Per-deployment env var: `STORE_PREFIX`

Not a secret — a plaintext Pages **environment variable** that namespaces every R2 key
(`{STORE_PREFIX}/data-{id}.enc`, `{STORE_PREFIX}/raw/{id}/{file}`, `{STORE_PREFIX}/processed/...`)
so concurrent branch deploys never collide within a bucket. It is committed **per-branch** in
`wrangler.jsonc` `"vars"` (`dev` → `"dev"`, `main` → `"prod"`), so it binds on a normal deploy with
no dashboard step. It is the *second* line of defence, not the only one: dev and prod are
also physically separate buckets and databases (VAULT.md §8). The
key-builder (`functions/_lib/store.ts` `storeKey`, mirrored by `scripts/vault-sync.ts`
`resolveStore`) **throws on an empty prefix** rather than risk an unprefixed shared key.

## TL;DR — paste this at the top of any terminal

After the first-time setup below, every new shell needs the same three things on the
environment. Once your deps are installed and you have a token, this is all it takes:

```bash
cd apps/lexitar
eval "$(~/homebrew/bin/brew shellenv)"        # node/npm on PATH
export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem  # VPN/proxy cert fix — without it wrangler "fetch failed"
export CLOUDFLARE_API_TOKEN=<your-token>      # auth (Cloudflare Pages: Edit)
npx wrangler whoami                           # should print your account
```

(Or add the `eval` and `export NODE_EXTRA_CA_CERTS` lines to `~/.bash_profile` so only the
token export is left.) First time through? Follow Step 0 onward.

## Reproducible setup — wrapper, doctor, external token

The manual env dance above is now wrapped so it reproduces on a fresh clone / new machine / CI:

- **The Cloudflare token is NOT in this repo** — it lives in a local credentials directory
  (`cloudflare.env`), loaded by `scripts/creds.sh`. Point `PLOVER_CREDENTIALS_DIR` at that
  directory; it defaults to `~/.claude/infra/cloud/credentials`. It's account-scoped, so rotate it
  if it is ever exposed.
- **`scripts/wrangler.sh`** — run any wrangler command through it and PATH + `NODE_EXTRA_CA_CERTS` +
  the token are set for you: `npm run wrangler -- <args>` (e.g. `npm run wrangler -- whoami`). No more
  re-deriving the CA export or the token.
- **`npm run doctor`** (`scripts/check-env.sh`) — fail-fast preflight: verifies Node on PATH, the CA
  bundle, the external `cloudflare.env` + its two vars, and warns if `.dev.vars` is missing. Run it
  first when something "just doesn't work."
- **Deploy-time D1 migrations** — apply new migrations to remote D1 with
  **`npm run d1:migrate:remote`** (wraps `wrangler d1 migrations apply health-identity-dev --remote`);
  local e2e uses `npm run d1:migrate:local`. This replaces a previously hand-run command.
  **Latest: `migrations/0009_recovery_grants.sql`** — applied to **both** databases 2026-08-25
  (`health-identity-dev` and `health-identity-prod`).

  > Applying it to prod ahead of the code is deliberate and is the safe order: both objects are
  > additive and nothing on `main` reads them yet, so when the promotion lands, the routes find the
  > schema already there. The reverse order is what broke patient uploads on dev when 0008 landed.
  >
  > Note the mechanic, because it is not obvious: **wrangler resolves a database name against the
  > worktree's own `wrangler.jsonc`**, so `health-identity-prod` cannot be migrated from the `dev`
  > worktree at all — it errors rather than guessing. Run it from a worktree checked out on `main`.
  > Until the promotion lands, that worktree does not yet contain the migration file, so copy it in,
  > apply, and delete it; the real file arrives with the promotion and wrangler skips it by name. It
  > adds `accounts.email_changed_at` and `recovery_grants`. Note
  the companion step: **`npm run raw:backfill -- --confirm`** should run once per store, from the
  worktree that binds it. **Both are done (2026-08-26):** dev 106 of 107 attributed (the holdout belongs
  to a patient who revoked org recovery, so nothing can open their vault to resolve it); **prod 35 of 35,
  zero orphans.** Re-running is a no-op — `INSERT OR IGNORE`, and it reports `already attributed`.

  Run it again after any bulk import that predates ownership recording. An unattributed object is not a
  breakage — an unclaimed namespace is allowed by design (`functions/_lib/raw-owner.ts`) — it is simply
  readable by any authenticated account until something claims it.

  Previously: `migrations/0008_account_erasure.sql` — needs applying to BOTH databases. It adds
  `accounts.deleted_at` and the `raw_objects` ownership table. Until it is applied, `POST
  /api/account/erase` fails on the first write and `/api/raw` PUT fails on the ownership insert, so
  this one is not optional on a deploy — unlike an additive column nothing reads yet.
- **Node is machine-specific** — `~/homebrew/bin` is this box's Homebrew prefix. A fresh machine / CI
  must supply its own Node on PATH; the wrapper only *adds* `~/homebrew/bin` when present, it can't
  install Node. (Inherently non-portable — documented, not "fixed.")

## Step 0 — environment & Cloudflare login (do this first)

Run these **in order**. Every `wrangler` command is run through `npx` from the app directory —
there is **no global `wrangler`** (it's a devDependency), so a bare `wrangler …` says "command
not found." Likewise, a fresh terminal often doesn't have `node`/`npm` on PATH yet — that's the
first thing to fix.

```bash
cd apps/lexitar                    # all commands run from here

# 1. Put node/npm on PATH for this shell. On this machine Homebrew lives in ~/homebrew.
#    Skipping this is why `node --version` prints "command not found".
eval "$(~/homebrew/bin/brew shellenv)"     # if brew is elsewhere: eval "$($(which brew) shellenv)"
node --version                             # must print v25.x before continuing

# 2. Trust the system CA bundle. A VPN/corporate proxy intercepts TLS here, so without this
#    wrangler's API calls fail with "fetch failed" / certificate mismatch. (Same workaround
#    the ingest pipeline uses.) Keep this exported for every wrangler command this session.
export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem

# 3. Install deps once (brings in wrangler). Safe to re-run.
npm install

# 4. Authenticate to Cloudflare (one-time; opens a browser).
npx wrangler login                         # non-interactive/CI: instead `export CLOUDFLARE_API_TOKEN=<token-with-Pages-edit>`
npx wrangler whoami                        # must print your account before continuing
```

If `node --version` still fails after step 1, find brew with `which brew` (or
`ls ~/homebrew/bin/brew /opt/homebrew/bin/brew /usr/local/bin/brew`) and use that path in the
`eval`. To avoid doing this every time, add the `eval "$(~/homebrew/bin/brew shellenv)"` line to
`~/.bash_profile`.

**If `npx wrangler login` fails** — the browser ends on a `http://localhost:<port>/oauth/callback…`
page that won't load, and `npx wrangler whoami` still says "not authenticated". `login` runs a
temporary local server to catch that redirect; if it isn't still running when the browser comes
back (it timed out, or you Ctrl-C'd it), the callback hits nothing. Either re-run `npx wrangler
login` and approve in the browser **promptly while the command stays running**, or skip OAuth
entirely with an **API token** (more reliable):

1. https://dash.cloudflare.com/profile/api-tokens → **Create Token → Custom token**.
2. Permissions: **Account › Cloudflare Pages › Edit** (covers `pages secret put`); optionally
   **Account › Account Settings › Read** so `whoami` resolves. Scope it to your account, create, copy.
3. `export CLOUDFLARE_API_TOKEN=<token>` then `npx wrangler whoami` — must print your account.
   (Lives only in that shell; re-export in a new terminal or add it to `~/.bash_profile`.)

You also need a **distinct** Anthropic API key (created in the Anthropic console on its own
budget) ready to paste in Step 3.

## Step 1 — confirm the Pages project name

The commands below don't hardcode a project name — `wrangler` reads it from the **`name`**
field in `wrangler.jsonc`, set to the Pages **project name**. Note the project name is **not**
necessarily the `*.pages.dev` subdomain: Cloudflare auto-suffixes the domain. Here the project
is **`health-dash-dev`** while its domain is **`health-dash-aex.pages.dev`**. Use the
**Project Name** column from `wrangler pages project list`, not the domain:

```bash
npx wrangler pages project list   # the "Project Name" column must match wrangler.jsonc "name"
grep '"name"' wrangler.jsonc      # → health-dash-dev
```

If you deploy to a **different** project, change that one line in `wrangler.jsonc` (every
command here follows it) — or override per-command with `--project-name <other>`.

> **Dev vs prod.** Today only `health-dash-dev` exists (matching the `*-dev`/`*-prod` pattern of
> the other projects, e.g. `tiny-tars-dev`/`tiny-tars-main`). When a `health-dash-main` project
> is added, secrets are **per-project** — set `ANTHROPIC_API_KEY` on each one
> separately. Point at prod by overriding the flag (`--project-name health-dash-main`) or, if
> prod becomes the default target, by changing `wrangler.jsonc` `name`. The `npm run allowlist`
> value is the same for both (it's derived from the client ids, not the environment).

## Step 3 — set the secrets

```bash
npx wrangler pages secret put ANTHROPIC_API_KEY
#   → paste the DISTINCT Anthropic key when prompted

npx wrangler pages secret put CHAT_TOKEN
#   → paste the `npm run allowlist` line when prompted

npx wrangler pages secret put RAW_TOKEN
#   → paste the SAME `npm run allowlist` line (gates GET /api/raw)
```

- `npx wrangler pages secret put` sets **production** secrets, which is what
  `health-dash-aex.pages.dev` uses. If you ever test a **branch/preview** URL
  (`<branch>.health-dash-aex.pages.dev`), set the secrets for that environment too.

## Step 4 — redeploy (REQUIRED — secrets don't bind without it)

Cloudflare **Pages binds secrets at deploy time, not per-request** (unlike Workers), so the
currently-live build won't see what you just set. Trigger a fresh deployment:

- **Push any commit** to the production branch (this repo auto-deploys), **or**
- Cloudflare dashboard → the project → **Deployments → latest → ⋯ → Retry deployment**.

(Historical, while the bearer guard existed.) Until you redeployed, chat returned `401` for **every** bearer — the guard read `CHAT_TOKEN` as
unset → empty allowlist → rejects all. This is the single most common "I set it but it still
fails" cause. A Pages build is ~1–3 min.

## Step 5 — verify

**Browser:** open `https://health-dash-aex.pages.dev/`, **unlock with a client id** (opaque since G1 — read it from `roster.json`, it is not a name), click
**Chat**, ask a question → you should get an answer.

**CLI (faster, no browser):** hit the prod endpoint with a derived bearer. `401` = secret not
bound/wrong (redeploy or re-set); `200`/`502` = auth passed (`502` = the Anthropic key is
invalid or out of credits).

```bash
BEARER=$(printf '%s' "$CLIENT_ID" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
curl -s -X POST https://health-dash-aex.pages.dev/api/chat \
  -H "authorization: Bearer $BEARER" -d '{"question":"ok?","context":{}}' -w '\n[%{http_code}]\n'

npx wrangler pages secret list      # both secrets should be listed (values hidden)
```

## Account recovery

Every account gets a **recovery code** at signup (shown once). If a user loses their password/passkey,
the lock screen's **"Forgot password?"** takes an email + the recovery code and signs them back in
(`/api/auth/recovery/{salt,login}`). The code is verified server-side (a stored `SHA-256(authHash)`,
same scheme as password) and is **reusable** until regenerated. Users can **regenerate** it from
**Account → Regenerate recovery code** (shown once).

> **No account credential is recorded in this repo (2026-08-09).** A recovery code wraps the same
> account private key as the password does — so a documented code is a documented vault key, exactly the
> hole the passwords were. The `recover-{slug}` codes this section used to tabulate, and the pilot
> passwords they were provisioned with, were **rotated on 2026-08-09** to random 20-character secrets and
> delivered out of band. `npm run vault:rotate` and `npm run vault:rotate -- --method recovery` re-check
> that no account has drifted back onto a value this repo ever wrote down; both are clean as of that date.
> Making a lost credential recoverable *without* writing one down is what the recovery-code mechanism
> above implements.

`scripts/set-recovery-code.ts` still exists for provisioning a chosen code against a deployed env (it
takes `EMAIL`/`PASSWORD`/`CODE` from the environment). Use it with a generated code, never a memorable
one, and do not paste the result back into this file.

## Which passphrase to log in with

The bearer is derived from the passphrase you unlock with, and the allowlist contains the
**per-client** ids only:

- ✅ a client id — the per-client slices (`records/public/data-<id>.enc`). Chat works.
- ❌ `fam4` — the master/family vault. Its hash is **not** in the allowlist, so chat returns
  `unauthorized` even with a selected client. If you want to chat from the family login too,
  add it — no longer needed: the allowlist is dead (2026-08-26), a new patient needs no secret change.

## When to re-run

Whenever a client slice is added (a new `records/public/data-<id>.enc`), re-run `npm run allowlist`,
(obsolete) `npx wrangler pages secret put CHAT_TOKEN …`, **then redeploy (Step 4)** so the new patient is
authorized.

To rotate a key: re-run the same `npx wrangler pages secret put …` command with the new value,
**then redeploy** — secrets only bind on a new build.

## The vault R2 bucket & `VAULT_TOKEN` (one-time, for `/api/vault`)

`/api/vault/[id]` persists each per-client encrypted blob to an R2 bucket so edits survive from
a phone without your laptop. The bucket binding rides `wrangler.jsonc` (already committed), but
the bucket and write-secret are account actions you run once (from `apps/lexitar/`, with
Step 0's PATH/CA/login in effect):

```
# 1. Create the bucket (name must match wrangler.jsonc → r2_buckets.bucket_name).
npx wrangler r2 bucket create health-vault

# 2. Set the write-secret. VAULT_TOKEN is minted independently now that CHAT_TOKEN is gone; a DISTINCT
#    secret so a chat-token leak can't grant vault overwrite. Re-run npm run allowlist if needed.
npx wrangler pages secret put VAULT_TOKEN --project-name <project>   # paste the allowlist line

# 3. Redeploy (push, or trigger a build) — secrets bind only on a new build (same rule as chat).
```

Verify (after deploy):

```
# GET self-seeds R2 from the committed static slice on first read → 200.
# §G: needs the ops bearer or a session with an envelope for this vault (else 401/403).
curl -s -o /tmp/v.enc -w "%{http_code}\n" -H "authorization: Bearer <VAULT_TOKEN>" \
  https://<domain>/api/vault/<client-id>
# PUT needs the per-client bearer (the same value chat uses for that id)
curl -X PUT https://<domain>/api/vault/<client-id> -H "authorization: Bearer <derived>" \
  -H "content-type: application/octet-stream" --data-binary @records/public/data-<client-id>.enc   # → 204
curl -X PUT https://<domain>/api/vault/<client-id> -H "authorization: Bearer nope" \
  --data-binary @records/public/data-<client-id>.enc   # → 401
```

Explicit seeding is optional (first GET self-seeds); to pre-load anyway:
`npx wrangler r2 object put health-vault/dev/data-<client-id>.enc --file records/public/data-<client-id>.enc`.

**Re-run when a client slice is added:** (obsolete, CHAT_TOKEN is gone) re-run `npm run allowlist`, re-set
`VAULT_TOKEN`, redeploy. **Follow-ups (separate steps):** wire the CLI pull/push sync once
the bucket is seeded, and enable Logpush → R2 retention (see `API.md`).

## Adding a new user (client) — end-to-end

The deploy-side steps that authorize a new patient. The CLI vault-creation is in README
("Ingest CLI"); the parts that matter for auth/persistence:

1. **Create the vault** (CLI): `npm run ingest -- --init --client <Id> --display-name "<Name>"`,
   then load their metrics/factors. This writes `records/public/data-<id>.enc` (lowercase id) and
   refreshes `records/roster.enc`. The slice is encrypted with the lowercase id as its
   passphrase — that id is what the user logs in with.
2. **Regenerate the bearer allowlist** (now includes the new slice):
   `npm run allowlist` → copy the stdout line (the comma-joined per-client hashes).
3. **Re-set `VAULT_TOKEN`** to the new value:
   ```
   npx wrangler pages secret put VAULT_TOKEN --project-name health-dash-dev
   ```
   (`CHAT_TOKEN` and `RAW_TOKEN` were part of this step until 2026-08-26; both are deleted and
   neither is read by any Function.)
4. **Redeploy** (merge to `main` / trigger a build) — secrets bind only on a new build.
5. **R2**: nothing to do — the new slice **self-seeds** into the bucket on its first
   `GET /api/vault/<id>`. (Optional pre-seed: `npx wrangler r2 object put
   health-vault/dev/data-<id>.enc --file records/public/data-<id>.enc`.)
6. The user logs in with their **lowercase id** as the passphrase. Chat + vault-read work
   immediately; vault **write** from the browser requires the Edit UI (see note below).

## Audit trail — watch vault writes & chat requests live

Functions emit one PHI-free structured JSON line per request (`functions/_lib/log.ts`). Stream
the live deployment's logs:

```
npx wrangler pages deployment tail --project-name health-dash-dev
# vault save (audit) → {"at":…,"route":"/api/vault","status":204,"id":"<client-id>","bytes":405312}
# chat request         → {"at":…,"route":"/api/chat","status":200,"usage":{"input":…,"output":…}}
# narrow it:  … | grep '/api/vault'
```

The vault line is **id + byte-size only — never the encrypted blob, plaintext, passphrase, or
bearer**. It's the disaster-recovery record for R2's last-write-wins overwrites. Durable
retention beyond Cloudflare's short default window is a follow-up item (Logpush → R2).

> **Editing from the deployed site.** The deployed app is **read-write**: unlocking a client
> shows **Edit**, and **Save** PUTs the re-encrypted blob to R2 via `/api/vault/{id}` (the write
> shows up in the audit tail above). Markers stay read-only — only user-authored fields
> (profile, conditions, meds, study, plan, …) are editable. The PUT is guarded by the
> per-client bearer + Cloudflare Access + the passphrase, so a user can only write a vault they
> can already unlock and read.

## Local development (no Pages secrets)

Local dev reads `.dev.vars` (gitignored) instead of Pages secrets — see `.dev.vars.example`:

```
# apps/lexitar/.dev.vars
ANTHROPIC_API_KEY=sk-ant-...
VAULT_TOKEN=<output of `npm run allowlist`>   # for /api/vault
```

Then `npm run dev:functions` (build + `npx wrangler pages dev dist`) serves the Functions at
`http://localhost:8788`. Plain `vite dev` does **not** run Functions, so `/api/chat` and
`/api/vault` 404 there (and the dev build deliberately uses the on-disk save path, not R2). To
exercise R2 locally, add `--r2 VAULT`: `npx wrangler pages dev dist --r2 VAULT`.

## Letting Claude run wrangler headlessly (no terminal paste)

Claude's shell does **not** inherit `CLOUDFLARE_API_TOKEN` (it's only in your interactive
session). The token lives in a local credentials directory, so `scripts/wrangler.sh` loads it
automatically — every wrangler call Claude makes is just:

```
npm run wrangler -- <…>          # sources creds.sh → cloudflare.env, sets PATH + CA, runs wrangler
```

Or, to source it manually into the current shell (e.g. for a raw `npx wrangler`):

```
export PATH="/Users/finca/homebrew/bin:$PATH"          # node/npm live here
export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem           # VPN/proxy TLS
CRED="${PLOVER_CREDENTIALS_DIR:-$HOME/.claude/infra/cloud/credentials}"
set -a; source "$CRED/cloudflare.env"; set +a
npx wrangler <…>
```

**Token scopes** (create at dash.cloudflare.com/profile/api-tokens → Custom token): Account ·
*Cloudflare Pages* · Edit; Account · *Workers R2 Storage* · Edit; Account · *Account Settings* ·
Read. Missing R2 is what gave `Authentication error [code: 10000]`; missing account read gives
the "Unable to retrieve email" warnings. Read-only is safer day-to-day, but Edit is needed for
`secret put` / `r2 object` / deploys. Rotate the token in the dashboard if it leaks; the file is
gitignored so it won't be committed.

> Trade-off: this lets Claude make **account-level changes** (set secrets, write/delete R2
> objects, deploy) without a confirmation paste. That's the intent — but it's real authority.
> Claude still won't push to a deploying branch or run destructive R2 ops without saying so.

## wrangler command catalog (common ops we use)

All from `apps/lexitar/`, with the env above exported.

```
# Discovery
npx wrangler pages project list                                  # projects + domains
npx wrangler pages deployment list --project-name health-dash-dev
npx wrangler pages deployment tail   --project-name health-dash-dev   # live PHI-free logs

# Secrets (bind only on a NEXT build — redeploy after)
npx wrangler pages secret list --project-name health-dash-dev
printf '%s' '<value>' | npx wrangler pages secret put VAULT_TOKEN --project-name health-dash-dev

# R2 (vault bucket)
npx wrangler r2 bucket create health-vault
npx wrangler r2 object put    health-vault/dev/data-<id>.enc --file records/public/data-<id>.enc
npx wrangler r2 object get    health-vault/dev/data-<id>.enc --file /tmp/out.enc
npx wrangler r2 object delete health-vault/dev/data-<id>.enc

# Redeploy (to bind new secrets) — push to the deploying branch, or in the dashboard:
#   health-dash-dev → Deployments → latest → Retry deployment
```

Contract checks can also be run with plain `curl` against the public domain
(`https://health-dash-aex.pages.dev/api/vault/<id>`) — Cloudflare Access does **not** block the
`/api/*` routes, so Claude verifies prod directly (GET 200 / PUT 204 with the derived bearer /
401 on a bad bearer). PUT the bytes a GET just returned to stay idempotent (no data change).

## Identity/escrow ops (D1 migrations, DEK rotation, purging a test account)

The account/identity/escrow layer lives in **Cloudflare D1** (`health-identity-dev`), PHI stays in
R2-encrypted vaults. Ops details:

- **D1 migrations.** `migrations/000{1..6}_*.sql`. Apply to prod with **`npm run d1:migrate:remote`**
  (local e2e uses `d1:migrate:local`; `scripts/e2e-serve.sh` runs it + wipes state each boot). `0002`
  seeds the pilots + the **org operational account** (`00000000-0000-4000-8000-000000000001`, its public
  key, and a per-vault org-recovery envelope). `0003` = support audit + `expires_at`. `0004` =
  `vaults.rotation_pending`. `0006` = `vaults.org_recovery_revoked_at`. **After adding a
  migration, run `d1:migrate:remote` at deploy** — this is a standing checklist item, easy to forget.
- **Org-key decrypts are logged.** `vault:build`, `vault:verify`, `vault:restore`, and
  `ingest --reconcile` each call `scripts/access-log.ts` (`recordOrgKeyUse` / `flushOrgKeyUses`) around
  every org-key decrypt, batching one `phi_access_events` INSERT over `wrangler.sh d1 execute --remote`
  when the script's `main` exits — so those four commands now need remote D1 access (the committed
  token) even for otherwise-offline runs. A flush failure is a hard error by design (a silent audit
  trail is the failure mode this closes). **`ORG_ACCESS_LOG=off`** is the documented escape hatch for
  genuinely offline work — it drops the buffered uses instead of flushing them.
- **DEK rotation is client-side.** Support revoke/expiry re-keys the vault in the browser
  (`/api/vault/principals` → re-wrap targets, `/api/vault/rotate` → atomic envelope swap). Expiry (patient
  offline) sets `rotation_pending`; the patient's next login completes it. **`reconcile` now reads a
  vault's DEK from the D1 org-recovery envelope** (`scripts/org-d1.ts`, via this wrapper) so it tracks a
  re-keyed R2 blob — it therefore needs remote D1 access (the committed token). `vault:verify` /
  `vault:build` are unaffected by rotation itself (committed `records/public/*.enc` + `.dek.enc` only —
  a prod re-key never touches them), but per the bullet above, both now need remote D1 access anyway to
  log the org-key decrypt. Verify rotation deployed with a throwaway account (sign up → `/api/vault/rotate` →
  new DEK opens the blob, old DEK fails, fresh login unwraps the new DEK); **then purge it (below)**.
- **Provisioning (out-of-band).** Support account: `scripts/provision-support-account.ts` → SQL →
  `npm run wrangler -- d1 execute health-identity-dev --remote --file …` (prod support agent =
  `support@local.invalid`; its password was rotated off the slug and is not recorded here).
  Pilot recovery codes: `scripts/set-recovery-code.ts` (see
  §"Account recovery").
- **Purging a throwaway/test account from prod** (delete children before the account row, then the R2
  blob). Find it, then:
  ```bash
  ACC=<account-id>; VAULT=<vault-id>
  npm run wrangler -- d1 execute health-identity-dev --remote --command "
    DELETE FROM vault_envelopes WHERE vault_id='$VAULT';
    DELETE FROM phi_access_events WHERE actor_account_id='$ACC' OR subject_account_id='$ACC';
    DELETE FROM provider_links WHERE patient_account_id='$ACC' OR provider_account_id='$ACC';
    DELETE FROM crm_events WHERE account_id='$ACC';
    DELETE FROM credentials WHERE account_id='$ACC';
    DELETE FROM identities WHERE account_id='$ACC';
    DELETE FROM public_keys WHERE account_id='$ACC';
    DELETE FROM vaults WHERE vault_id='$VAULT';
    DELETE FROM accounts WHERE id='$ACC';"          # --command runs multiple stmts fine; or use --file
  npm run wrangler -- r2 object delete "health-vault/dev/data-$VAULT.enc" --remote
  ```
  (Never purge a pilot or the org account this way — it would orphan the survival/recovery model.)

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `unauthorized` (401) | No valid `hd_session` cookie — the session expired, or `SESSION_SECRET` was rotated after the deploy was built (Pages binds secrets at deploy time). Before 2026-08-26 this was a `CHAT_TOKEN` mismatch. | Sign in again; if it persists, confirm `SESSION_SECRET` is set and **redeploy** so the new build picks it up. |
| `unauthorized` after setting it | `wrangler.jsonc` `name` ≠ the deployed project, or secret set on preview while testing production | Confirm with `npx wrangler pages project list` vs `wrangler.jsonc`; set on the right environment. |
| `unauthorized` for one login only | Unlocked with a non-allowlisted passphrase (e.g. `fam4`) | Use a client id, or add the id to the allowlist. |
| `chat backend error` (502) | `ANTHROPIC_API_KEY` missing, invalid, or out of credits | Set/replace it; confirm the distinct key has budget. |
| `/api/chat` returns 404 | Hitting `vite dev` instead of the Function | Use `npm run dev:functions` locally, or the deployed URL. |

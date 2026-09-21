# VAULT.md — the health-dash vault architecture

How patient data is stored, encrypted, read, written, and synced across the browser, the
Cloudflare Pages Functions, R2, and the local CLI. This is the map; the operational runbooks live
in `AUTH.md` (secrets/deploy) and `API.md` (endpoint contracts).

> **Passphrases are not stored in this repo.** `<vault-passphrase>` (the roster/slice passphrase,
> env `PASSPHRASE`) and `<org-passphrase>` (env `ORG_KEY_PASSPHRASE`) live in a local credentials
> file (`health-dash.env`, not committed in this repo), loaded via `scripts/load-creds.ts`. Source it
> before running any command below:
> `set -a; . "${PLOVER_CREDENTIALS_DIR:-$HOME/PabloTech/plover-keys}/health-dash.env"; set +a`.

## 1. Data model — four layers under one umbrella

Everything lives under **`records/`**, split by the security boundary: `private/` (plaintext PHI,
**never web-served**) and `public/` (the derived, still-encrypted, served layer; Vite's `publicDir`).

```
records/
  roster.enc                       encrypt(private/roster.json, pass=<vault-passphrase>) — NOT served
  private/                         plaintext PHI, at rest, opens in VS Code, key-loss-proof
    roster.json                    names-only provider directory (plaintext source of roster.enc)
    {client}/                      records/private/{client-id}/  (opaque since G1: the lowercased account id)
      raw/                         original files, byte-for-byte, sha-addressed (PDF/XLSX)
      processed/{sha8}.json        ONE pre-fold extraction artifact per raw source (deterministic)
      vault.json                   consolidated PLAINTEXT vault — the CLI read/write SOURCE OF TRUTH
  public/                          derived, encrypted, committed, web-served (publicDir → dist root)
    data-{id}.enc                  encrypt(private/{client}/vault.json, pass=id)
```

**The roster sits outside `public/` on purpose.** It has no browser consumer — the provider's patient
list moved to `/api/providers/patients` at the account-based-auth cutover — so serving it only published the one
artifact that maps an opaque client id back to a patient's name, under the weakest crypto here
(v1/PBKDF2, outside the envelope model). Being outside Vite's `publicDir` is the mechanism: it cannot
be shipped by forgetting.

The four layers and how they relate:
- **raw** — the source files exactly as imported (sha256 dedup; `SourceRecord.file` points here).
- **processed** — `records/private/{id}/processed/{sha8}.json`, one **pre-fold** extraction per raw
  source (lab parser rows / imaging `ImagingExtraction`). Durable, inspectable; replaces the old
  gitignored `.cache/`. (`scripts/processed-store.ts`.)
- **vault.json** — the consolidated plaintext vault (markers, factors, study, finding, ranges,
  `sources[]`). **This is what the CLI reads and writes.** Markers/diseases are rebuildable from
  processed; Finding/ranges are LLM-generated and persist here (exactly why plaintext-at-rest matters).
- **served `.enc`** — a pure function of `vault.json`: `vault:build` encrypts plaintext → the served
  ciphertext; `vault:verify` decrypts each `.enc` and asserts it equals its `vault.json` (drift guard,
  in the pre-push gate + `tests/unit/vault-integrity.test.ts`).

**Plaintext at rest is the source of truth** (owner decision; this is a private repo). The served
`.enc` stays AES-GCM/browser-decrypted — the privacy model (server never sees plaintext; the only
world-readable thing is ciphertext) depends on it. Tradeoff: cleartext PHI in git → a public-visibility
flip requires **purging `records/private/` from history**, not just rotating keys.

### The served blobs stay world-readable (decided 2026-08-31)

`records/public/data-{id}.enc` is fetchable unauthenticated by anyone who knows the id, on both
deployments. `/api/vault/{id}` gates the same bytes, but that gate is **audit, not secrecy** — the
static asset is the fallback it reads from (§6). This is accepted, not overlooked, and the reasons
are what make it acceptable rather than the other way round:

- **The ciphertext is the control.** A v2 blob is AES-GCM under a per-vault DEK, itself ECDH-wrapped
  per principal. Fetching it yields bytes. That is the same property the whole model rests on — the
  server never sees plaintext either.
- **The id no longer says who.** Before G1 the filename was the patient's first name, so the URL was
  guessable and the exposure was real. It is now the opaque account uuid: not guessable, and since
  G8 stopped serving the roster, not mappable back to a name by anything the world can read.
- **Gating it buys nothing and costs the cold path.** Every reader that matters already holds a
  session; the static blob is what makes a first load work before one exists.

**What would reverse this decision**, either half of which turns world-readable into world-openable:
an id becoming enumerable (a listing endpoint, a sitemap, a directory index), or a blob reverting to
**v1 — whose passphrase is its own id**, the very string the URL hands out.
`tests/unit/vault-opacity.test.ts` holds both halves: no served filename embeds a name (G1), no
served blob opens as the roster (G8), and every served blob is v2 (G10).

### Keys (recorded here per the private-repo secret policy)

> **Account passwords are NOT recorded here (2026-08-09).** The password an account signs in
> with is *also* the KEK that unwraps its private key, hence the vault DEK — so writing one down here
> would be writing down the decryption key. The seeded values (each account's own slug) were
> rotated to random 20-character secrets on 2026-08-09 and delivered out of band; they exist in no
> file in either repo. `npm run vault:rotate` re-checks that no account has drifted back to a
> guessable value, and is the tool that rotates one. See `BACKUP.md`.

- **Per-client vault (legacy v1 / CLI):** passphrase = the client's **id** (opaque since G1).
  Applies only to a v1 blob; every live vault is v2 (DEK + envelopes), so this is history, not a live key.
- **Provider/roster (`records/roster.enc`):** passphrase = **`ROSTER_PASS`**, its own 32-character
  secret in `health-dash.env` (still v1; not part of the envelope model — which is why it is no longer
  served). Rotated onto it 2026-08-31 by `npm run roster:rotate`; `--check` is the standing audit.

  It previously shared `PASSPHRASE`, whose value is the **public provider slug** — four characters, and
  classed as non-secret. One string doing both
  jobs was the real defect, and not because of the KDF: while a credential is also a public identifier,
  no textual scan can tell a disclosure from a legitimate mention, which is how a live provider login
  sat unnoticed inside the *credential-free* Playwright project (G8). The roster is the one artifact
  mapping an opaque client id back to a patient's name, so it is the last thing that should be behind a
  guessable string. `ROSTER_PASS` collides with nothing, which is what makes the next collision visible.

  **`PASSPHRASE` keeps one job: the migration-seeded provider login**, and it stays the slug because
  `migrations/0002` is applied history. That is scoped, not residual risk — the remote dev and prod D1s
  were rotated off every seeded value (`npm run vault:rotate` confirms), so the seeded value now
  opens only the local, migration-built e2e database on a machine that already holds the records.
- **Account login (the app now):** accounts sign in with an email + password. The password is the
  KEK that unwraps the account's private key → the vault DEK, so it is held only by the account
  holder. Login emails minted by `scripts/migrate-accounts.ts` were `{slug}@local.invalid`; change one
  via `PATCH /api/account`.
  - **Every vault now carries an org envelope by default (shipped).** An account that loses
    its password recovers via the org key unless the patient revoked it. What is not yet built is
    *user-triggered* recovery — a patient using a surviving credential (recovery code, passkey,
    Google) to set a new password unaided — still unbuilt.
- **Org operational key:** `records/org-key.json` holds a P-256 keypair whose private key is
  wrapped under the org passphrase **`<org-passphrase>`** (env `ORG_KEY_PASSPHRASE`; generated by
  `scripts/gen-org-key.ts`). Under the v2 envelope model each vault is encrypted with a random DEK;
  the DEK is wrapped to this org public key (the org-recovery envelope) so the CLI/ops pipeline
  (`vault-build`/`reconcile`/`vault-verify`/`migrate`) can still unwrap it and keep this plaintext-truth
  model working, while patients/providers hold their own keys. Losing this passphrase ⇒ the org can no
  longer operate on migrated vaults — treat it like `<vault-passphrase>`.
  (A fuller inventory + safeguard of every out-of-repo secret/config is a planned follow-up.)

**Names are labels, not identifiers (G1).** The client id — inside `vault.clients`, and as the slice
filename, passphrase, directory and R2 key alike — is the **lowercased account id**, the same opaque
value every signup has minted since `createFirstClient` shipped. The name survives only as
`client.displayName` *inside* the ciphertext. The CLI still takes `--client Alex`: `resolveClientId`
(`scripts/vault-io.ts`) folds a display name to its id once, at the boundary, so no runbook changed.
The lowercasing in `/api/raw` and the Export download is now a no-op, kept for a vault predating G1.
See `project_provider_roster_model`.

## 2. Encryption boundary (the core invariant)

Encryption/decryption happen **only in the browser and the local CLI — never on the server.**

### Decision (2026-08-09, owner): org recovery envelope ON by default — **implemented**

Every vault carries a **DEK envelope wrapped to the org operational key**, minted by the patient's own
client at signup. Four properties, all four load-bearing, and all four now shipped:

1. **On by default** — not opt-in. A health record that evaporates on a forgotten password is a worse
   patient outcome than the confidentiality risk the alternative buys, and the restore drill cannot
   prove a backup opens for a vault nobody but the holder can decrypt. **Mint at signup, all three
   paths:** `functions/api/auth/password/signup.ts:143-149`, `functions/api/auth/passkey/register/verify.ts:158-164`,
   `functions/_lib/google.ts:131-133,155-161` (Google wraps server-side — it already generates the DEK
   there). Client-side crypto for the two browser paths: `src/lib/auth-client.ts` `signupPassword` /
   `signupPasskey` fetch `GET /api/vault/org-key` and wrap the DEK to it before posting. **Backfill for
   accounts that predate this or missed it at signup:** `src/App.svelte:510` `ensureOrgRecoveryEnvelope()`,
   called from `enterAccount` (`:529`) right after `openOwnVault` — best-effort, never blocks or fails
   an unlock.
2. **Disclosed at signup** — in the same breath as the encryption claim, not buried in a policy. The
   lock screen now says the record is encrypted end-to-end *and* that LexiTar holds a removable
   recovery key (`src/App.svelte:1615`, signup-mode copy), and the public site repeats the disclosure
   (`../tinytars/src/pages/health-literacy.astro:144-148`).
3. **Revocable by the patient** — `deleteEnvelope` (`functions/_lib/identity.ts:446`) is called by
   `DELETE /api/vault/recovery-envelope` (`functions/api/vault/recovery-envelope.ts:81-99`), which also
   sets the durable `vaults.org_recovery_revoked_at` (migration `0006_org_recovery.sql`). UI: the
   Account modal's "Recovery key" block (`src/App.svelte:2014-2038`) states the consequence — *nobody
   can recover the record, including us* — in the confirm step before calling `doRevokeRecoveryKey()`
   (`:955`).
4. **Every use logged** — to `phi_access_events`, and surfaced to the patient. Server-side mint/revoke
   write `insertAccessEvent` inline (`functions/api/vault/recovery-envelope.ts:70,95`, actions
   `org_recovery_minted` / `org_recovery_revoked`). The org key itself lives only in the CLI, so its
   decrypts are logged from there: `scripts/access-log.ts` (`recordOrgKeyUse` / `flushOrgKeyUses`,
   action `org_key_decrypt`), called from every decrypt site — `scripts/vault-v2.ts:75`,
   `scripts/vault-build.ts:41`, `scripts/vault-verify.ts:49`, `scripts/vault-restore.ts:233`,
   `scripts/ingest.ts:779` — with each script's `main` flushing on exit. Patient-visible read:
   `GET /api/account/access-events` (`functions/api/account/access-events.ts`), the first caller of
   `listAccessEventsForSubject`, rendered in the same Account modal block.

**Why not the stricter line.** An earlier draft made escrow opt-in, on the reasoning that an
operator who can decrypt is a backdoor. That over-read the requirement — the objection was to access
*without permission*, and disclosed-plus-revocable is permission. It also ignored that this system
already ships consent-gated privileged access (`functions/api/support/approve.ts`, with expiry and a
re-key on exit), and it made a PHI migration runner unbuildable: a migration must decrypt, so
"the org can never decrypt" meant "prod can never be migrated". The axis that matters is
**disclosure, audit and revocability — not capability**.

What is unchanged: the server still never decrypts **in the request path**, never sees a password, a
KEK or a DEK, and moves only sealed blobs. The org key is an out-of-band operator credential
(`ORG_KEY_PASSPHRASE`, a local credentials file), not something the Functions hold.
`src/lib/crypto.ts`: AES-GCM-256, key from **PBKDF2-SHA256, 200k iterations**; blob layout is `"HD1"`
magic (`0x48 0x44 0x31`) + version + 16-byte salt + 12-byte IV + ciphertext. The Functions only ever
move **already-encrypted HD1 blobs** (vault) or **plaintext raw bytes** (raw originals) — never a key.

```
encryptVault(data, pass) -> [ HD1 | ver | salt | iv | AES-GCM(JSON) ]
decryptVault(blob, pass) -> data        (throws on wrong pass / non-HD1 / corrupt)
```

## 3. Bearer auth (no secret in the bundle)

The browser proves "I can already unlock this vault" without sending the passphrase:
`deriveBearerToken(pass) = base64url(SHA-256(pass))` (`src/lib/crypto.ts`). The server holds an
**allowlist** of those hashes as Pages secrets and constant-time compares (`functions/_lib/guard.ts`):

- `CHAT_TOKEN` — **deleted 2026-08-26**; `POST /api/chat` is gated by `hd_session`.
- `VAULT_TOKEN` — gates `PUT /api/vault/{id}`.
- `RAW_TOKEN` — **deleted 2026-08-26**; `/api/raw` is gated by `hd_session` + `rawAccessFor`. Raw originals are **plaintext PHI**, so unlike
  the open `.enc` GET this route is bearer-gated.

All three are **distinct secrets** (rotate independently) but hold the **same value today** — the
`npm run allowlist` output. Re-run + redeploy when a client is added. See `AUTH.md`.

## 4. Read path (unlock)

`src/App.svelte:unlock()` fetches the slice, checks the HD1 magic, and `decryptVault`s it:

```
browser unlock(pass)
  ├─ dev  (import.meta.env.DEV):  GET /data-{pass}.enc        (records/public served at dist root)
  └─ prod:                        GET /api/vault/{pass}       (R2; self-seeds from static on miss)
        -> isHD1? -> decryptVault(blob, pass) -> render
  (the roster is CLI-only — records/roster.enc, served in neither)
```

## 5. Write path — the `VaultSink` abstraction

Editing re-encrypts in the browser and hands the blob to a `VaultSink` (`src/lib/vault-sink.ts`).
Selection is **build-time** (`vaultSink = import.meta.env.DEV ? localSink : r2Sink`):

```
Edit -> Save -> saveVault(vault, id, pass, vaultSink, bearer)
  ├─ dev   localSink:  POST /__save-vault?id={id}   (Vite middleware → records/public/data-{id}.enc
  │                                                   AND decrypts → records/private/{id}/vault.json)
  └─ prod  r2Sink:     PUT  /api/vault/{id}          (bearer-guarded → R2)
```

The deployed app is **read-write**: unlock → Edit → Save persists to R2 from a phone. Markers stay
read-only (ingestion owns them). The dev save keeps the plaintext `vault.json` in sync so a dev web-edit
can't drift from the served `.enc`.

## 6. The Pages Functions

**`functions/api/vault/[id].ts`** — moves the encrypted HD1 blob; never decrypts. R2 key is
**store-prefixed**: `storeKey(env, "data-{id}.enc")` → `{STORE_PREFIX}/data-{id}.enc` (§7).
- **`GET`** (ops bearer `VAULT_TOKEN`, or a session holding an envelope for this vault — §G; `401`
  unauthenticated, `403` authenticated without an envelope). The gate is audit, not secrecy: the same
  bytes stay world-readable as static blobs by design. Read R2 → on
  miss, fall back to the **static asset** (unprefixed `data-{id}.enc`) via `env.ASSETS` only if it's a
  real HD1 blob (else `404`), and lazily **self-seed** the prefixed R2 key. `no-store`.
- **`PUT`** (bearer `VAULT_TOKEN`): validate HD1 (`400`), ≥ 32 bytes (`400`), ≤ 5 MB (`413`) →
  `env.VAULT.put(storeKey…)` → `204`. PHI-free audit line `{route:"/api/vault", status, id, bytes}`.

**`functions/api/raw/[[path]].ts`** — **`GET /api/raw/{id}/{file}`**, session-gated
(`hd_session`; the `RAW_TOKEN` this line used to name is not read by the Function — corrected,
along with the authorisation gap recorded in `API.md`):
`env.VAULT.get(storeKey(env, "raw", id.toLowerCase(), file))` → streams the plaintext original with a
content-type by extension; `400` bad path, `404` miss, PHI-free log `{route:"/api/raw", status, id}`.
Never decrypts (raw is stored unencrypted).

Because these objects are plaintext and outside the encryption boundary, a Worker can read them —
and since W-corpus every AI route does: the PDFs under `raw/{id}/` are attached to each inference
about that person as `document` blocks ([`CORPUS.md`](CORPUS.md)), through the same `rawAccessFor`
gate this route uses. Encrypting raw originals would end that, which is the trade the boundary
here was already making and is now paying for.

**`DELETE /api/raw/{id}/{file}`**
(same gate) expunges one raw object from R2 (`env.VAULT.delete(...)`) → `{deleted:true}`;
idempotent. It's the web-delete shape: the browser runs the pure `removeSource()`, `PUT`s the
re-encrypted vault, then `DELETE`s the raw object.

Contracts + curl examples: `API.md`.

## 7. R2 layout (store-prefixed) + CLI sync + build/verify

**Today all deploys share one bucket** (the `health-dashboard` dev deploy, any branch preview), so every
R2 key is namespaced by a **store prefix** — never a flat key. (This is the *current* mechanism; the
adopted target is separate per-environment buckets — see §8.)

```
health-vault/
  {store}/                         per-deployment namespace (env.STORE_PREFIX; dev branch = "dev")
    data-{id}.enc                  vault ciphertext
    raw/{id}/{file}                originals (plaintext PHI) — session-gated via /api/raw
    processed/{id}/{sha8}.json     extractions (lets a CLI pull web-extracted artifacts)
```

- `STORE_PREFIX` is a committed per-branch Pages var (`wrangler.jsonc` `"vars"`; this branch = `"dev"`,
  a future prod branch = `"prod"`). The key-builder **`functions/_lib/store.ts` `storeKey`** throws on
  an empty prefix (a missing one would silently merge two deploys' keys). `scripts/vault-sync.ts`
  `resolveStore` mirrors it CLI-side.
- **CLI sync** (`scripts/vault-sync.ts`): `pull(id, store)` before a load, `push(id, store)`
  after a write; a raw `--import` also `pushRaw`s the originals to `{store}/raw/{id}/`. Shells to
  `wrangler r2 object get/put --remote` with the machine's ambient `CLOUDFLARE_API_TOKEN`. `--no-sync`
  for offline. Without it, a CLI regen from a stale slice would clobber a phone edit.
- **build/verify**: `npm run vault:build` encrypts plaintext → served `.enc`;
  `npm run vault:verify` decrypts each `.enc` and deep-equals its `vault.json` — in the pre-push gate.

  **If `vault:verify` fails with `Unexpected end of JSON input`** on a `vault.json` that was fine a
  moment ago (not a hand-edit, not a `vault:build` you ran): that's an empty (0-byte) file, not
  corrupted JSON — `npm run doctor` (`scripts/check-env.sh`) checks for exactly this, fast, and
  names the file. `git checkout -- records/private/{id}/vault.json` recovers it (it's a committed
  fixture). The only code that writes this file is `vite.config.ts`'s dev-only `/__save-vault`
  middleware (§ below), which writes atomically (temp file + rename) so a killed/crashed
  write can no longer leave it partial — if it happens again anyway, the likely trigger is **another
  `npm run dev` running against this same checkout** (a second terminal, a second agent session, or a
  stray browser tab still POSTing to `/__save-vault`) racing with whatever else touched the file.

  **Update:** the atomic-write fix above did *not* stop it — corruption was reproduced twice more
  afterward, with no `vite`/`wrangler`/`node` process running at inspection time, so the `/__save-vault`
  race is likely not the whole story. `scripts/vault-watch.sh` polls the fixtures and, the instant one
  drops in size, captures `lsof`/`ps`/`tmutil`/`log show` evidence to `.vault-watch/` (gitignored)
  before self-healing via `git checkout` — run it (`bash scripts/vault-watch.sh &`) if you're actively
  investigating a live occurrence. Read-only forensics so far point loosely at Time Machine/Spotlight
  (`backupd`/`mds`/`mdworker` unusually active in the corruption window; not confirmed).

**Reconciliation:** R2 (under `{store}`) is authoritative for the running app; `records/private/` is the
durable, inspectable repo copy for that branch. A web edit writes only its deployment's `{store}`; the
branch's repo plaintext goes stale until the next `vault:sync pull`.

**Backups:** because of that staleness, `records/private/` is *not* a user backup — a beta user's
vault exists only in R2. A nightly snapshot copies every `{store}/…` object plus a full D1 export into
the separate `health-vault-backup` bucket, and a restore drill re-opens every vault from that snapshot
alone. Runbook, layout, retention and the missed-run alarm: **`BACKUP.md`**.

## 8. Environments — two stores, dev and prod

There are **two independent stores**, one per Pages project, and the split is enforced twice over:

| | `health-dash-dev` (branch `dev`) | `health-dash-main` (branch `main`) |
|---|---|---|
| R2 bucket (`VAULT`) | `health-vault` | `health-vault-prod` |
| D1 (`DB`) | `health-identity-dev` | `health-identity-prod` |
| `STORE_PREFIX` | `dev` | `prod` |
| Preview deployments | on (every branch) | **off** — see below |

**Separate buckets *and* the prefix — not either alone.** The prefix guard (§7) is good, but it makes
isolation depend on one string being right in one env var. A separate bucket means a `STORE_PREFIX`
bug, a mis-targeted script, or a bad migration *cannot* reach prod data: the credential simply does
not address it. For PHI that margin is worth one extra bucket, so `STORE_PREFIX` is **kept**, not
retired — the two mechanisms compose, and the empty-prefix throw in `storeKey` remains the guard.

Dev keeps the historical bucket name `health-vault` (rather than being renamed `health-vault-dev`)
because renaming it would move live objects for no isolation gain — prod is a different bucket either
way, and a rename is a migration with a failure mode where a documentation change would do.

**The binding lives in `wrangler.jsonc`, per branch.** Cloudflare re-reads that file on every build
and it overrides the dashboard, so **a branch's copy *is* its environment**. `dev` and `main` differ
in exactly four keys — `name`, `bucket_name`, `database_name`+`database_id`, `STORE_PREFIX` — and
`.githooks/pre-push` fails the promotion on any difference *outside* those four, plus asserts main's
four values are the prod ones. That single check catches both directions: dev values carried through
to prod (live PHI into the wrong store), and a new binding or `compatibility_date` bump added on dev
that never reaches prod (prod silently stale).

**Preview deployments are off on prod** (`preview_deployment_setting: "none"`). The dev project
already previews every branch. Leaving previews on for prod would mean any pushed branch gets a
deployment bound to the prod bucket and prod D1 — the same class of accident this split exists to
prevent, arriving through a door nobody watches.

Moving the live beta users from dev into prod is its own procedure, with its own rollback:
**`CUTOVER.md`**. It is not automated on purpose.

**Verify either environment:** `npm run doctor` (this branch's project) or `npm run doctor:prod`.
It checks every env var the code reads is provisioned, the bindings resolve, `STORE_PREFIX` matches
the project, and — on prod — that previews are off. Secret *values* are unreadable (the Cloudflare
API returns `secret_text` masked), so presence and shape are all it can prove; see AUTH.md §
"Per-environment secrets" for the values that need a live test instead.

## 9. Provenance & removability (invariant; cascade delete — SHIPPED)

Every derived datum is **source-attributable**: `SourceRecord.id` === each derived entry's `sourceId`
(`MarkerResult.sourceId`, disease/comorbidity `sourceId`, `fromComparison` rows). No `SourceRecord`
without its `raw/` + `processed/` files. The pure `removeSource(client, sourceId, surviving?)`
(`src/lib/report-merge.ts`, re-exported from `ingest-core`) drops the record + every `sourceId`-tagged
datum, re-applies surviving sources' processed rows so a **corroborated** reading is kept (re-attributed),
and appends a PHI-free `removedSources[]` tombstone `{sourceId, sha8, kind, removedAt}`. Idempotent
(absent source → no-op; no duplicate tombstone). **Re-ingesting the same sha clears its tombstone**
(`upsertSourceRecord`).

CLI: `npm run ingest -- --client X --remove-source <id|sha8-prefix|filename>` — deletes the raw +
processed files, re-derives `vault.json`→`.enc`, deletes the R2 `{store}/raw|processed` objects, prints
the git-history note. **"Removed" (gone — e.g. wrong-patient) is distinct from "stale"** (valid data
whose Finding needs regen): a removal makes the Finding stale on its own (its `inputsHash` no longer
matches), but the deleted data is gone, not flagged.

`vault:verify` runs a per-client **provenance check** (`provenanceIssues`): fails the pre-push gate on a
dangling `sourceId`, a tombstone that collides with a live source, or a `SourceRecord` missing its raw /
processed file. Full-history expunge of a mis-ingested (wrong-patient) file needs a `git filter-repo`
purge.

> **Key loss is only harmless for the pilot records committed here.** For an account created through the
> app, the browser holds the key and losing it is real; "recover from the plaintext at rest" does not
> apply to them — `AUTH.md` has the ladder that does.

## 10. Key files

| Concern | File |
|---|---|
| Crypto + bearer derivation | `src/lib/crypto.ts` |
| Read/unlock + editing surface | `src/App.svelte` |
| VaultSink (local/R2 selection) | `src/lib/vault-sink.ts` |
| Vault Function (GET/PUT, store-prefixed) | `functions/api/vault/[id].ts` |
| Raw Function (GET/DELETE, session-gated) | `functions/api/raw/[[path]].ts` |
| Source removal cascade + provenance | `src/lib/report-merge.ts` (`removeSource`, `provenanceIssues`) |
| Account recovery (locked-out user) | `AUTH.md` |
| R2 key builder (store prefix) | `functions/_lib/store.ts` |
| Bearer guard / PHI-free log | `functions/_lib/guard.ts`, `functions/_lib/log.ts` |
| Chat Function | `functions/api/chat.ts` |
| CLI ingest / regen | `scripts/ingest.ts` |
| Processed-store / raw parser | `scripts/processed-store.ts`, `scripts/parse-source.ts` |
| CLI ↔ R2 sync (store-aware, raw) + R2 REST bulk access | `scripts/vault-sync.ts` |
| Backups: snapshot / restore drill / freshness alarm | `BACKUP.md`, `scripts/vault-snapshot.ts`, `scripts/vault-restore.ts`, `scripts/vault-snapshot-check.ts` |
| Plaintext → served encrypt / drift verify | `scripts/vault-build.ts`, `scripts/vault-verify.ts` |
| Bearer allowlist generator | `scripts/chat-allowlist.ts` |
| Export tab "Imported files" download | `src/lib/ExportTab.svelte` |
| Secrets / deploy / add-a-user runbook | `AUTH.md` |
| Endpoint contracts | `API.md` |

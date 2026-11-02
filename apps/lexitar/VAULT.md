# VAULT.md — the health-dash vault architecture

How patient data is stored, encrypted, read, written, and synced across the browser, the
Cloudflare Pages Functions, R2, and the local CLI. This is the map; the operational runbooks live
in `AUTH.md` (secrets/deploy) and `API.md` (endpoint contracts).

> **Passphrases are not stored in this repo.** `<vault-passphrase>` (the roster/slice passphrase,
> env `PASSPHRASE`) and `<org-passphrase>` (env `ORG_KEY_PASSPHRASE`) live in a local credentials
> file (`health-dash.env`, not committed in this repo), loaded via `scripts/load-creds.ts`. Source it
> before running any command below:
> `set -a; . "${LEXI_CREDENTIALS_DIR:-$HOME/PabloTech/lexi-keys}/health-dash.env"; set +a`.
> The file moved to LexiTar's own store on 2026-10-08 and this line named the estate's until then.
> Correcting it matters more than it reads: a machine that kept a copy of the old path still sources
> it successfully, so the stale spelling fails by loading an out-of-date value rather than by erroring.

## 1. Data model — four layers under one umbrella

> **`records/private/` does not exist in this repository, and nor does the CLI that reads it.** The
> tree and the §"Reconciliation"/"Backups" sections below describe `plover-code`'s `health-dash-web`,
> which this app was imported from — they came across with the document and were never true here.
> What lexi tracks under `records/` is three inert static assets, which is the whole of the
> `public/` row: `.gitignore:54` excludes the umbrella and re-includes only the served layer, and
> `CREDENTIALS.md` is where an operator artifact goes instead. Read the paragraphs below as the
> model the encryption formats were designed for, not as a description of this checkout.

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
- **processed** — one **pre-fold** extraction per raw source (lab parser rows / imaging
  `ImagingExtraction`), keyed in R2 at `{store}/processed/{id}/{sha8}.json` by `r2ProcessedKeyFor`
  (`scripts/vault-sync.ts:56`). **Nothing in this repository writes one**, and the browser fold says
  why at `src/lib/import-flow.ts:103`: processed is a regenerable derived cache and the readings
  already carry their `sourceId`, so the disk-only writer went with the CLI. What is left is custody
  of what earlier runs put there — the snapshot counts the class (`scripts/vault-snapshot.ts:127`), a
  re-key moves the prefix (`scripts/commands/rekey.ts:33`), and `scripts/vault-orphan-blobs.ts`
  sweeps it.
- **the vault record** — the consolidated vault (markers, factors, study, finding, ranges,
  `sources[]`). It exists as **ciphertext only**: the browser decrypts it, edits it and re-encrypts
  it, and the one plaintext copy written anywhere is the dev-only mirror of §5. Markers/diseases are
  rebuildable from processed; Finding/ranges are LLM-generated and persist in the record itself.
- **served `.enc`** — the record under its own DEK, HD1-framed (§2). It is no longer *derived* from
  anything: the build step that encrypted a plaintext file into it, and the drift guard that
  decrypted it back and compared the two, were deleted with the CLI that owned them. §7 says what
  this repository has in their place.

**Plaintext at rest was the source of truth, under a premise this repository has never met.** The
owner decision that sentence recorded — plaintext PHI committed, on the grounds that the repository
is private — belongs to `plover-code`, and the paragraph came across with the document. `tinytars/lexi`
has been public since 2026-09-09 and tracks no plaintext record at all. The served `.enc` stays
AES-GCM/browser-decrypted either way: the privacy model (the server never sees plaintext; the only
world-readable thing is ciphertext) is what the rest of this document describes, and it does not rest
on the premise above. What the old tradeoff line said would be needed on a visibility flip —
"purging `records/private/` from history" — has no referent here; the published material that did
need remediating is `migrations/0002` and the two artifacts Phase 4(b) untracked, and re-keying
rather than purging is what ended that exposure. See
`planning/lexi/remediate-published-key-material.md` in `promontory-studio/plover-context`.

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
`tests/unit/vault-opacity.test.ts` holds both halves, rebuilt 2026-10-06 against a tree that tracks
no record: every R2 key is minted from a server-generated id and the whole list of what that can be
is in the test (G1), the roster blob resolves outside the `publicDir` and no per-account ciphertext
is served at all (G8), and the `isV2` discrimination control holds the version floor (G10). Its own
header says what each guard gave up when the real roster and the real served blobs stopped being
on disk, and what replaced it.

### Keys — what each one opens, never a value

> Nothing below carries a secret, and the heading here used to say the opposite: "recorded here per
> the private-repo secret policy", on the same premise §1 corrects. Every value lives in the
> credential store; `CREDENTIALS.md` is the inventory and says which of the two placements each
> belongs in. What this section is for is the question a value cannot answer — what losing one costs.

> **Account passwords are NOT recorded here (2026-08-09).** The password an account signs in
> with is *also* the KEK that unwraps its private key, hence the vault DEK — so writing one down here
> would be writing down the decryption key. The seeded values (each account's own slug) were
> rotated to random 20-character secrets on 2026-08-09 and delivered out of band; they exist in no
> file in either repo. `npm run vault:rotate` re-checks that no account has drifted back to a
> guessable value, and is the tool that rotates one. See `BACKUP.md`.

- **Per-client vault (legacy v1 / CLI):** passphrase = the client's **id** (opaque since G1).
  Applies only to a v1 blob; every live vault is v2 (DEK + envelopes), so this is history, not a live key.
- **Provider/roster (`roster.enc`):** passphrase = **`ROSTER_PASS`**, its own 32-character secret in
  `health-dash.env` (still v1; not part of the envelope model — which is why it is no longer served).
  Rotated onto it 2026-08-31. **Two corrections, both measured 2026-10-06.** The blob is no longer
  tracked here — Phase 4(b) untracked `records/roster.enc`, and no code path in this repository reads
  it: the roster moved into D1 at the W44 cutover (`functions/api/providers/patients.ts:10`) and
  `src/lib/types.ts:17`'s `Roster` type is the only thing left that names the file. And
  `npm run roster:rotate`, which this row cited as the rotation tool, **exists in no `package.json`
  in this repository** — the CLI it belongs to stayed in `plover-code`. So there is no standing
  `--check` audit of this value here, and the honest statement of its status is that it opens a
  pre-W44 artifact that nothing in lexi loads.

  It previously shared `PASSPHRASE`, whose value is the **public provider slug** — four characters, and
  classed as non-secret. One string doing both
  jobs was the real defect, and not because of the KDF: while a credential is also a public identifier,
  no textual scan can tell a disclosure from a legitimate mention, which is how a live provider login
  sat unnoticed inside the *credential-free* Playwright project (G8). The roster is the one artifact
  mapping an opaque client id back to a patient's name, so it is the last thing that should be behind a
  guessable string. `ROSTER_PASS` collides with nothing, which is what makes the next collision visible.

  **`PASSPHRASE` now has no job at all, measured 2026-10-06, and the row above said it kept one.** Its
  last one was the migration-seeded provider login, and `migrations/0002` was rewritten that day to
  seed no credential for anyone — so a fresh local database has no login to borrow. Nor does anything
  else read it: swept across `src`, `functions`, `scripts`, `server` and `tests`, `PASSPHRASE`,
  `ROSTER_PASS` and `SEED_PASSPHRASE` appear only in comments describing what they used to open. All
  three were therefore removed from `snapshot.yml`'s job environment and from the `lexitar-op`
  composite action, because a repository secret handed to a job that reads it for nothing is exposure
  with no capability beside it. The values themselves are not destroyed — they stay in the credential
  store, where they remain the passphrase of historical artifacts, and `CREDENTIALS.md` is the
  inventory that says so. `ORG_KEY_PASSPHRASE` is the one of the four that is live.
- **Account login (the app now):** accounts sign in with an email + password. The password is the
  KEK that unwraps the account's private key → the vault DEK, so it is held only by the account
  holder. The accounts that predate signup carry `{slug}@local.invalid` emails, seeded by
  `migrations/0002_seed_migrated_accounts.sql`; the script that minted them is gone, and that
  migration was rewritten on 2026-10-06 to seed no credential for anyone. Change an email via
  `PATCH /api/account`.
  - **Every vault now carries an org envelope by default (shipped).** An account that loses
    its password recovers via the org key unless the patient revoked it. What is not yet built is
    *user-triggered* recovery — a patient using a surviving credential (recovery code, passkey,
    Google) to set a new password unaided — still unbuilt.
- **Org operational key:** `$LEXI_CREDENTIALS_DIR/org-key.json` holds a P-256 keypair whose
  private key is wrapped under the org passphrase (env `ORG_KEY_PASSPHRASE`; generated by
  `scripts/gen-org-key.ts`, which refuses to write inside a git work tree). It was
  `records/org-key.json` until 2026-10-06 and that is the incident this remediation exists for: a
  key holding a recovery envelope on every migrated vault, committed to a repository that went
  public. `scripts/org-key.ts:28` has no in-repo fallback left, and the keypair that file published
  has been replaced. Under the v2 envelope model each vault is encrypted with a random DEK;
  the DEK is wrapped to this org public key (the org-recovery envelope) so the operator pipeline can
  still unwrap a vault whose holder is not at the terminal, while patients/providers hold their own
  keys. It reaches the key through exactly one module — `scripts/org-unwrap.ts`, which
  `tests/unit/org-key-chokepoint.test.ts` pins as the only route and which logs every use — and the
  commands behind it are `npm run vault:restore`, `npm run vault:rekey`,
  `npm run r2-ops -- --reconcile` and `npm run raw:encrypt`. Losing this passphrase ⇒ the org can no
  longer operate on migrated vaults — treat it like `<vault-passphrase>`.
  (A fuller inventory + safeguard of every out-of-repo secret/config is a planned follow-up.)

**Names are labels, not identifiers (G1).** The client id — inside `vault.clients`, and as the slice
filename, passphrase, directory and R2 key alike — is the **lowercased account id**, the same opaque
value every signup has minted since `createFirstClient` shipped. The name survives only as
`client.displayName` *inside* the ciphertext. **The CLI no longer takes `--client Alex`**, and this
paragraph said it did: the boundary that folded a display name to its id went with the CLI that
owned it, so `--client` is the opaque vault id and nothing in this repository resolves a name to one
(`scripts/r2-ops-args.ts:55`). What survives is narrower and is a different question — once a vault
is open, `resolveClientKey` (`scripts/vault-ops.ts:33`) picks the client *inside* it, falling back to
the sole one and refusing to guess among several. The lowercasing in `/api/raw` and the Export
download is now a no-op, kept for a vault predating G1 (`src/lib/client-id.ts`).
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
   there). Client-side crypto for the two browser paths: `@tinytars/vault/auth-client`'s
   `signupPassword` / `signupPasskey`, called from `src/App.svelte:820-821` through
   `src/lib/auth-flow.ts`, fetch `GET /api/vault/org-key` and wrap the DEK to it before posting. **Backfill for
   accounts that predate this or missed it at signup:** `src/App.svelte:510` `ensureOrgRecoveryEnvelope()`,
   called from `enterAccount` (`:529`) right after `openOwnVault` — best-effort, never blocks or fails
   an unlock.
2. **Disclosed at signup** — in the same breath as the encryption claim, not buried in a policy. The
   lock screen now says the record is encrypted end-to-end *and* that LexiTar holds a removable
   recovery key (`src/App.svelte:1615`, signup-mode copy), and the public site repeats the disclosure
   (`../tinytars/src/pages/health-literacy.astro:144-148`).
3. **Revocable by the patient** — `deleteEnvelope` (`functions/_lib/identity-vault.ts:67`) is called by
   `DELETE /api/vault/recovery-envelope` (`functions/api/vault/recovery-envelope.ts:73-96`), which also
   sets the durable `vaults.org_recovery_revoked_at` (migration `0006_org_recovery.sql`). UI: the
   Account modal's "Recovery key" block (`src/App.svelte:2014-2038`) states the consequence — *nobody
   can recover the record, including us* — in the confirm step before calling `doRevokeRecoveryKey()`
   (`:955`).
4. **Every use logged** — to `phi_access_events`, and surfaced to the patient. Server-side mint/revoke
   write `insertAccessEvent` inline (`functions/api/vault/recovery-envelope.ts:70,95`, actions
   `org_recovery_minted` / `org_recovery_revoked`). The org key itself lives only in the CLI, so its
   decrypts are logged from there — and since 2026-09-27 that is a mechanism rather than a request.
   **One module turns the org key into a decryption key:** `scripts/org-unwrap.ts`, the only importer
   of `loadOrgPrivateKey`. It writes the `org_key_decrypt` entry (`scripts/access-log.ts`) *before* it
   returns a key, and refuses an id it could not audit before any crypto runs, so a use that cannot be
   logged fails before the key exists. `tests/unit/org-key-chokepoint.test.ts` sweeps `scripts/` and
   fails the build when another file reintroduces the shortcut. Until then each decrypt site loaded the
   key itself and was asked, by a comment, to log alongside it — and two never did
   (`scripts/raw-backfill.ts`, `scripts/recovery-approve.ts`, both audited from that date).
   **A recorded use can also no longer be lost.** `ORG_ACCESS_LOG=off` used to clear the buffer and
   return; now it, an unreachable D1, and a script that exits without flushing all spool to
   `${XDG_STATE_HOME:-~/.local/state}/lexitar/access-spool.ndjson` (0600; ids, script and purpose — no
   PHI, no key material), which the next online flush drains. Patient-visible read:
   `GET /api/account/access-events` (`functions/api/account/access-events.ts`), the first caller of
   `listAccessEventsForSubject`, rendered in the same Account modal block.

**The boundary of that claim.** "No DEK without an audit row" is a property of *this repository*, not
of the machine: anyone holding `ORG_KEY_PASSPHRASE` and `org-key.json` can write their own
twenty lines. What the chokepoint delivers is that no code path in this tree yields a key without
recording a use — the same distinction `ARCHITECTURE.md` draws between the server *enforcing* access
and the server being *able* to read. The audit it enforces covers the org key only, but it is no longer
the only audit: since 2026-09-27 the read routes `GET /api/vault/{id}`, `GET /api/raw/...` and
`POST /api/document-extract` write a `phi_access_events` row for every read that is **not the owner's
own**, through the one helper `functions/_lib/phi-audit.ts`. A person reading their own record still
writes nothing, deliberately — a single view is tens of reads, and burying the third-party reads under
the owner's own clicks turns a disclosure log into a traffic log — so §4a's owner-credential export is
unlogged by design rather than by omission, and §4b's third-party one is recorded object by object.

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
`@tinytars/vault/crypto`: AES-GCM-256, key from **PBKDF2-SHA256, 200k iterations**
(`@tinytars/vault/kdf`); blob layout is `"HD1"`
magic (`0x48 0x44 0x31`) + version + 16-byte salt + 12-byte IV + ciphertext. The Functions only ever
move **already-encrypted HD1 blobs** — the vault under its DEK, each raw original under its own
content key (§2a) — never a key.

```
encryptVault(data, pass) -> [ HD1 | ver | salt | iv | AES-GCM(JSON) ]
decryptVault(blob, pass) -> data        (throws on wrong pass / non-HD1 / corrupt)
```

## 2a. Raw originals are sealed too (2026-09-24)

An uploaded original — the PDF a patient hands LexiTar — used to sit in R2 as the file itself. It was
authorised (session + `rawAccessFor`), which is real, but authorisation is not encryption: anyone
holding the bucket read them. They were the most sensitive files here and the only ones outside the
boundary above.

Each one now carries **its own AES-GCM-256 content key, minted in the browser**, and is stored as an
HD1 v3 envelope (`@tinytars/vault`'s `encryptBytes` — the same 32-byte header, an opaque payload
instead of UTF-8 JSON). The keys live in **`Vault.rawKeys`**, a `{clientId: {file: base64}}` map
*inside the vault blob*, so they are encrypted at rest by construction and three properties come for
free rather than being built:

| Property | Why it is free |
|---|---|
| Who can decrypt | Exactly whoever can open the vault — owner, org (unless revoked), active providers. No new principal set. |
| Revocation | `DELETE /api/vault/recovery-envelope` already removes org access to the vault, and so to the keyring. |
| DEK rotation | `/api/vault/rotate` re-encrypts the blob that *contains* the keyring; no object moves. |

A document and its `text/{id}/{key}.json` transcription sidecar share **one** content key — a
cleartext transcription beside sealed bytes would make the sealing cosmetic.

**The key is written to the vault before the ciphertext is uploaded** (`src/lib/vault-raw-keys.ts`).
The ordering is the whole invariant: a sealed object whose key was never saved is unopenable, and
because the report corpus reads every `raw_objects` row under a namespace, one of them refuses that
patient's *every* question. An unused key costs nothing; a lost one cannot be recovered.

**Two lanes seal what was already there**, and both are needed. `src/lib/raw-seal-heal.ts` runs in
the browser on each record open, diffing the namespace's recorded objects (`GET /api/raw/{id}?files=1`)
against this vault's ring — **the only lane that reaches an account which revoked org recovery**.
`scripts/raw-encrypt-backfill.ts` (`npm run raw:encrypt`, an operator command at their own terminal
— `docs/OPS-LOCAL.md`, since it needs the org private key no runner has) does the same store-wide through the org recovery envelope, and refuses an orphaned
namespace so its bytes stay claimable.

**Both lanes have run to zero in production, measured 2026-11-02**: 35 originals, all 35 sealed, each
one decrypted afterwards to prove the sealing had not destroyed it (`DPGA.md` §9A has both
measurements and why two are needed). Sealing is a **salvage** — the bytes are encrypted at the same
R2 key and the content key written into that owner's own vault, key first and read back before any
ciphertext is written, so the patient goes on opening every document and the operator stops being
able to. What the lanes structurally cannot reach is the orphaned namespace and the one whose owner
revoked org recovery; production has neither, and a third control now says so nightly without being
asked (`npm run raw:seal-sweep`, wired into `snapshot.yml`, keyless so it can run hosted).

**The deployment still sees plaintext while its owner is using the record.** It must: it is the thing
that base64s the document into the model request, and the browser hands it the ~12 KB key map per
request (`CORPUS.md`). *Using* is wider than *asking* — the corpus is sent when a record is **opened**
(`functions/api/corpus-warm.ts`) and kept warm for up to twelve idle refreshes, so the window is the
owner's session rather than their question (`CORPUS.md` §4). What this buys is everything at rest — bucket exposure, a leaked storage token, a
snapshot, the backup bucket — and the end of any standing operator ability to read a patient's files.

## 3. Bearer auth (no secret in the bundle)

The browser proves "I can already unlock this vault" without sending the passphrase:
`deriveBearerToken(pass) = base64url(SHA-256(pass))` (`@tinytars/vault/crypto`). The server holds an
**allowlist** of those hashes as Pages secrets and constant-time compares (`functions/_lib/guard.ts`):

- `CHAT_TOKEN` — **deleted 2026-08-26**; `POST /api/chat` is gated by `hd_session`.
- `VAULT_TOKEN` — gates `PUT /api/vault/{id}`.
- `RAW_TOKEN` — **deleted 2026-08-26**; `/api/raw` is gated by `hd_session` + `rawAccessFor`. Raw
  originals are sealed (§2a), but the gate stays: encryption is not authorisation, and unlike the
  open `.enc` GET this route answers for one named patient.

All three are **distinct secrets** (rotate independently) but hold the **same value today** — the
`npm run allowlist` output. Re-run + redeploy when a client is added. See `AUTH.md`.

## 4. Read path (unlock)

`src/App.svelte:unlock()` fetches the slice, checks the HD1 magic, and `decryptVault`s it:

```
browser unlock(pass)
  ├─ dev  (import.meta.env.DEV):  GET /data-{pass}.enc        (records/public served at dist root)
  └─ prod:                        GET /api/vault/{pass}       (R2; self-seeds from static on miss)
        -> isHD1? -> decryptVault(blob, pass) -> render
  (the roster is CLI-only, and the CLI stayed in plover-code — served in neither)
```

### 4a. Operator record export (`npm run record:export`, 2026-09-27)

One command gives a complete local copy of **one** record — the structured data, every stored
document, and the cached text of each — by taking the same read path a browser takes.

```
npm run record:export -- [--client <key>] [--dry-run] [--stdout] [--purge]
```

The flags that read *someone else's* record are §4b's, and the operator's guide to the whole feature —
provisioning, how a patient grants and revokes, the weekly renewal — is `docs/RECORD-EXPORT.md`.

- **Principal: the record's own owner.** `scripts/api-session.ts` signs in with
  `POST /api/auth/password/login`, unwraps the account key from the passphrase and the DEK from the
  owner envelope, and reads the ciphertext through `GET /api/vault/{id}` — so
  `resolveEnvelopeAccess` stays in the path and the CLI holds no authority the owner's browser does
  not. **Not the org key** (§2): that opens every vault and a CLI reaching R2/D1 directly bypasses
  the one place the system makes an authorization decision.
- **The passphrase is stored nowhere, including `plover-keys`.** `LEXITAR_CLI_EMAIL` names the account
  and `LEXITAR_BASE_URL` the origin; the passphrase is asked for on the terminal, unechoed, and held in
  memory for the run. It is also the KEK that opens the record (§1), which is why
  `scripts/rotate-pilot-credentials.ts` prints a rotated one once and records it nowhere — a standing
  `LEXITAR_CLI_PASSWORD` in a credentials file would reinstate, on one record, the same shape the org
  key was rejected for. The env var remains for an unattended run against a synthetic patient, whose
  password is a public literal (`scripts/provision-e2e-patient.ts`).
- **A support principal's password *may* sit in `plover-keys`, and that is not a softening of the rule
  above.** `LEXITAR_SUPPORT_EMAIL` and `LEXITAR_SUPPORT_PASSWORD` (`npm run support:provision`,
  `scripts/provision-support-account.ts`) name an account that owns no record, so its password is a KEK
  for nothing: it lets the CLI present itself, and it reaches a record only while a patient's grant is
  live, expiring by itself. The names are deliberately distinct from `LEXITAR_CLI_*` so the rule above
  stays true as written instead of being edited into something weaker.
- **Destination:** `$XDG_STATE_HOME/lexitar/exports/{blobId}-{stamp}/`, mode 0700, holding
  `record.json`, `documents/`, `transcripts/` and `manifest.json`. `LEXI_EXPORT_DIR` overrides it.
- **Refusals, with no `--force`:** `scripts/export-dir.ts` rejects any destination inside a git work
  tree or under `records/`, at run time — an ignore rule is not the control, because this repo is
  public and its `.gitignore` re-includes `records/**`. A sealed object with no content key is
  reported `unreadable(missing content key)`, never silently skipped.
- **Stdout is contents-free** — ids, counts, sha8, kind, bytes, sealed-or-not, opened-or-not — because
  the common caller is an agent whose transcript must not become a second copy of the record. `--stdout`
  is the explicit opt-in to print `record.json` as well.
- **Removal:** `npm run record:export -- --purge`, or the `rm -rf` line every run prints last. A local
  copy is a class of copy self-service erasure cannot reach, which is why `ERASURE_REACH`
  (`src/lib/erase-account.ts`) names it.
- **No audit row for an owner reading their own record**, deliberately: `auditPrivilegedRead`
  (`functions/_lib/phi-audit.ts`) returns without writing when actor === subject, so a person's own
  clicks cannot bury the third-party reads their access screen exists to surface. Every read that is
  *not* the owner's own is recorded — which was §4b's stated prerequisite, and is done.
- **Deliberately absent from `ops.yml`.** A CI runner is the wrong place for plaintext PHI, and this
  follows the read-only-inspection convention (`scripts/treatment-diagnose.ts`) of staying local.

### 4b. A third party at the CLI (built, 2026-09-27)

§4a gives the **record's own owner** a command line. This is the other principal: one operator
exporting the records of a family who are not them, driven by
`npm run record:export -- --request / --list / --patient / --url / --all` and documented for the
operator in `docs/RECORD-EXPORT.md`. It exists because the operator who asked for §4a signs in with
Google and a passkey and therefore has no password to type — the one credential §4a needs is the one
credential that account does not have.

**The principal is a `support` account, not a clinician one.** Both could read; only one could be left
in a file. A `primary` provider link carries `recovery:issue`
(`functions/_lib/capabilities.ts`), which `functions/api/recovery/grant.ts`'s own header calls "the
ability to turn read access into ACCOUNT CONTROL" — so a standing clinician password is an
account-takeover credential for every patient linked to that clinician, and no scoping argument
recovers it. A `support` link is refused that route twice over (the capability is `primary`-only and
the route re-checks `role === "primary"`), and it arrives with the three things a disclosure needs
already built: a `consent_ref` stamped per grant window, a time box the patient chooses, and an audit
row per open (`functions/_lib/routes/support-access.ts`). It also cost no new token type and no user
interface change: the TTL dropdown the patient approves from already offers 24h, 3 days and **7 days**
(`src/App.svelte`), and the server clamps at `maxTtlHours: 720`.

**Read-only is now enforced, not assumed.** `PUT /api/vault/{id}` gated on holding an envelope for the
vault, which a support principal does — so the read credential could overwrite the record it was
approved to read. The PUT now refuses a caller who is neither the owner nor a `primary` link holder,
and `tests/unit/vault-put-principal.test.ts` pins it. `POST /api/recovery/grant` additionally requires
fresh re-authentication, so a stored credential is no longer sufficient there either, and whether the
challenge could be made at all is recorded in the audit row's `meta` rather than hidden behind one 200.

**Nothing durable is cached.** The password sits in `plover-keys` (§4a's fourth bullet says why that is
not a softening of the rule above); no session token and no account key is ever written to disk, so
each run signs in fresh and revocation bites on the next run rather than whenever a cached key expires.
The pasted-address resolver (`scripts/resolve-owner.ts`) is in-process only: a client-key → owner map on
disk would be a record of which family members exist, which is the fact the record exists to protect,
and the resolution ladder makes it unnecessary.

**The roster is still a PHI-adjacent read**, and that has not changed: `GET /api/providers/patients`
returns `displayName` and `email` in the clear per patient (`functions/api/providers/patients.ts`), so
it now writes one `provider_roster_viewed` row **per patient** rather than one per listing. The CLI's
own listing endpoint is the envelope-free `GET /api/support/owners`, which is why it is the cheap one to
poll and why it discards the name and address at the call site instead of printing them.

**The prerequisite this section used to state is met.** §2's boundary paragraph used to name three
unaudited privileged read routes — `functions/api/providers/patients.ts`, `functions/api/vault/[id].ts` and
`functions/api/raw/[[path]].ts` — and called closing them "a prerequisite to building this, not a
follow-up". They now route through `auditPrivilegedRead` (`functions/_lib/phi-audit.ts`), which writes
one row per privileged read and returns without writing when actor === subject, so a person's own
clicks cannot bury the third-party reads their access screen exists to surface. Revoking a clinician
link is audited too (`provider_access_revoked`), which it was not: an invisible revocation undercuts
half of what a patient needs to be able to prove. The `/api/raw` subject is the **vault's owner**, never
the namespace's first writer, which is very often the clinician — filing the latter would have recorded
the wrong person as the one whose record was read (`tests/unit/raw-owner-subject.test.ts`).

## 5. Write path — the `VaultSink` abstraction

Editing re-encrypts in the browser and hands the blob to a `VaultSink`
(`@tinytars/vault/vault-sink`). Selection is **build-time**
(`vaultSink = import.meta.env.DEV ? localSink : r2Sink`), and every write this app makes goes through
one funnel: `saveRecord` at `src/App.svelte:160`, which nothing below it calls past.

```
Edit -> Save -> saveVaultV2(vault, id, dek, vaultSink)
  ├─ dev   localSink:  POST /__save-vault?id={id}   (Vite middleware → records/public/data-{id}.enc,
  │                                                   then best-effort → records/private/{id}/vault.json)
  └─ prod  r2Sink:     PUT  /api/vault/{id}          (bearer-guarded → R2)
```

**The passphrase is no longer in that call, and the DEK is.** A v2 record is encrypted with a random
DEK wrapped per principal (§2), so the sink is handed the key rather than something to derive one
from — which is also what lets a conflicting write be seen rather than silently won: the sinks carry
the object's ETag (`rememberVaultEtag`, `VaultConflictError`) instead of re-deriving and overwriting.

The deployed app is **read-write**: unlock → Edit → Save persists to R2 from a phone. Markers stay
read-only (ingestion owns them). The dev-only plaintext the middleware drops under
`records/private/` is a convenience for reading back what you just saved — **gitignored, untracked,
written by nothing else and read back by nothing at all** (`.gitignore:55`, `vite.config.ts`). It is
not a fixture, and no gate compares it to the served ciphertext.

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
`env.VAULT.get(storeKey(env, "raw", id.toLowerCase(), file))` → streams whatever is stored, with a
content-type describing the **document** rather than the envelope; `400` bad path, `404` miss,
PHI-free log `{route:"/api/raw", status, id}`. It never decrypts — a caller that can read the bytes
is a caller that holds the key (§2a). **`PUT` refuses an unsealed body** — `415
plaintext_refused`, unconditionally, including on a namespace's first upload — and logs `envelope`,
the version byte read back out of the bytes that are about to land. A number rather than the
`sealed: true` that line used to carry: on the far side of the only refusal that can reach it, a
boolean could take exactly one value, and a field that cannot disagree with its own code cannot
report the day the code is wrong. On the refusal it also says which way the refusal went — `null`
for a body that is no envelope, `2` for a vault blob offered as an original.

Every AI route still attaches these documents server-side: the PDFs under `raw/{id}/` ride along with
each inference about that person as `document` blocks ([`CORPUS.md`](CORPUS.md)), through the same
`rawAccessFor` gate this route uses. Sealing them did **not** end that — the corpus needs the bytes
readable *during a request the owner is making*, which is not the same as readable *at rest*, so the
browser sends the content keys with the request and the Worker opens them in memory.

**`DELETE /api/raw/{id}/{file}`**
(same gate) expunges one raw object from R2 (`env.VAULT.delete(...)`) → `{deleted:true}`;
idempotent. It's the web-delete shape: the browser runs the pure `removeSource()`, `PUT`s the
re-encrypted vault, then `DELETE`s the raw object.

Contracts + curl examples: `API.md`.

## 7. R2 layout (store-prefixed) + what reaches it

**Today all deploys share one bucket** (the `health-dashboard` dev deploy, any branch preview), so every
R2 key is namespaced by a **store prefix** — never a flat key. (This is the *current* mechanism; the
adopted target is separate per-environment buckets — see §8.)

```
health-vault/
  {store}/                         per-deployment namespace (env.STORE_PREFIX; dev branch = "dev")
    data-{id}.enc                  vault ciphertext
    raw/{id}/{file}                originals, sealed under a per-file content key (§2a)
    processed/{id}/{sha8}.json     extractions (lets a CLI pull web-extracted artifacts)
```

- `STORE_PREFIX` is a committed per-branch Pages var (`wrangler.jsonc` `"vars"`; this branch = `"dev"`,
  a future prod branch = `"prod"`). The key-builder **`functions/_lib/store.ts` `storeKey`** throws on
  an empty prefix (a missing one would silently merge two deploys' keys). `scripts/vault-sync.ts`
  `resolveStore` mirrors it CLI-side.
- **R2 access** (`scripts/vault-sync.ts`): the key builders every operator script shares, the
  object-level `listObjects`/`getObject`/`putObject`/`deleteObject` over the REST API, and the
  **live-write guard** — `assertLiveWriteAllowed` refuses a write to a deployed vault from anywhere
  but the sanctioned workflow, and `tests/unit/live-write-guard.test.ts` pins that refusal rather
  than trusting it.
  **Its disk-sync half is no longer driven by anything.** `pull`/`push`/`pushRaw`/`pullVaultTo` still
  move a ciphertext slice between R2 and the gitignored `records/public/` copy by shelling to
  `wrangler r2 object get/put --remote` with the machine's ambient `CLOUDFLARE_API_TOKEN`, and the
  only callers left are that guard test: the operator ops pull, mutate in memory and push again
  through `scripts/vault-ops.ts`, with no on-disk slice in between. The `--no-sync` offline switch
  this bullet used to promise is parsed by nothing — it survives only inside one of `pull`'s error
  strings — and so is the `--import` it named.
- **build/verify — there is neither, and there is nothing left for them to do.** The record is
  written once, as ciphertext, by the sink of §5: no plaintext file is encrypted into the served
  `.enc`, and no second copy exists to deep-equal it against. The two commands this bullet named,
  the drift check behind them and the pre-push gate that ran it all went with the CLI that owned
  them — the repository's `.githooks/` holds a `pre-commit` and nothing else, so **no git hook here
  opens a vault at all**. What stands in their place is narrower and is already stated above: the
  sink carries an ETag, so a concurrent write is refused rather than silently won (§5), and
  `npm run vault:snapshot:check` catches a backup that has gone stale (`BACKUP.md`).

  The zero-byte-plaintext corruption those commands kept catching — and the watcher written to
  catch it in the act — belong to the `health-dash-web` checkout they were debugged in, where a
  plaintext record was tracked. Nothing here tracks one, so there is no committed fixture to lose
  and none for `git checkout --` to bring back. `npm run doctor` (`scripts/check-env.sh`) still
  carries the probe, and its own comment now records why it cannot fire in this repository.

**Reconciliation:** R2 (under `{store}`) is authoritative, and it is the **only** copy — there is no
repo-side plaintext to reconcile against it and no pull command that would refresh one. A web edit
writes its own deployment's `{store}` and nothing else, and the two never converge (§8).

**Backups:** a user's vault therefore exists **only in R2**, which is what makes the nightly snapshot
the whole of the safety net rather than a second line of it. It copies every `{store}/…` object plus a full D1 export into
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
It checks every env var the code reads is provisioned, that nothing provisioned is unread,
`STORE_PREFIX` matches the project, and that the `preview` environment carries no secrets at all. Secret *values* are unreadable (the Cloudflare
API returns `secret_text` masked), so presence and shape are all it can prove; see AUTH.md §
"Per-environment secrets" for the values that need a live test instead.

## 9. Provenance & removability (invariant; cascade delete — SHIPPED)

Every derived datum is **source-attributable**: `SourceRecord.id` === each derived entry's `sourceId`
(`MarkerResult.sourceId`, disease/comorbidity `sourceId`, `fromComparison` rows). No `SourceRecord`
without its `raw/` object — and, for what earlier runs left behind, its `processed/` artifact (§1:
nothing here writes one). The pure `removeSource(client, sourceId, surviving?)`
(`@pablotech/akesi/report-merge`, re-exported from `ingest-core`) drops the record + every `sourceId`-tagged
datum, re-applies surviving sources' processed rows so a **corroborated** reading is kept (re-attributed),
and appends a PHI-free `removedSources[]` tombstone `{sourceId, sha8, kind, removedAt}`. Idempotent
(absent source → no-op; no duplicate tombstone). **Re-ingesting the same sha clears its tombstone**
(`upsertSourceRecord`).

Removal is driven from the app's **Reports** surface (`src/lib/HealthReports.svelte:91`), which runs
the same pure fold against a clone and persists it; the raw DELETE route
(`functions/api/raw/[[path]].ts:246`) deletes the R2 `{store}/raw|processed` objects and PUTs the
re-encrypted vault. There is no operator command for it: the person who can decrypt the vault is the
only one who can remove a source from it.

**"Removed" (gone — e.g. wrong-patient) is distinct from "stale"** (valid data
whose Finding needs regen): a removal makes the Finding stale on its own (its `inputsHash` no longer
matches), but the deleted data is gone, not flagged.

That invariant has a checker and **no longer has anything that runs it over a live vault.**
`provenanceIssues` (`@pablotech/akesi/report-merge`, re-exported from `ingest-core`) reports a
derived datum whose `sourceId` no live source answers for, a tombstone that is also live, and a
treatment claiming a photo or pasted-text extraction with no raw capture on file; what calls it is
`tests/unit/remove-source.test.ts`, against fixtures. The command that used to run it per client on
every push is gone with the CLI and there is no pre-push hook to run one — so the invariant is
pinned where the fold is written and unchecked where the records are. The file-existence half was
never in this function anyway (it is `fs`-free by design and says so); that was the caller's check,
and the caller is what went.
Full-history expunge of a mis-ingested (wrong-patient) file needs a `git filter-repo` purge.

> **Key loss is only harmless for the pilot records committed here.** For an account created through the
> app, the browser holds the key and losing it is real; "recover from the plaintext at rest" does not
> apply to them — `AUTH.md` has the ladder that does.

## 10. Key files

| Concern | File |
|---|---|
| Crypto + bearer derivation | `@tinytars/vault/crypto`, `@tinytars/vault/kdf` |
| Read/unlock + editing surface | `src/App.svelte` |
| VaultSink (local/R2 selection) + ETag conflict | `@tinytars/vault/vault-sink` |
| Vault Function (GET/PUT, store-prefixed) | `functions/api/vault/[id].ts` |
| Raw Function (GET/DELETE, session-gated) | `functions/api/raw/[[path]].ts` |
| Source removal cascade + provenance | `@pablotech/akesi/report-merge` (`removeSource`, `provenanceIssues`) |
| Account recovery (locked-out user) | `AUTH.md` |
| R2 key builder (store prefix) | `functions/_lib/store.ts` |
| Bearer guard / PHI-free log | `functions/_lib/guard.ts`, `functions/_lib/log.ts` |
| Chat Function | `functions/api/chat.ts` |
| Operator ops (fold pending / regen) | `scripts/r2-ops-cli.ts`, `scripts/commands/r2-ops.ts` |
| Browser fold (hash → classify → fold) | `src/lib/ImportTab.svelte`, `src/lib/import-flow.ts` |
| Raw parser (bytes → markers) | `src/lib/parse-raw.ts` |
| R2 access: key builders, REST bulk, live-write guard | `scripts/vault-sync.ts` |
| Backups: snapshot / restore drill / freshness alarm | `BACKUP.md`, `scripts/vault-snapshot.ts`, `scripts/vault-restore.ts`, `scripts/vault-snapshot-check.ts` |
| Bearer allowlist generator | `scripts/chat-allowlist.ts` |
| Export tab "Imported files" download | `packages/frame/ExportTab.svelte`, `src/lib/export.ts` |
| Secrets / deploy / add-a-user runbook | `AUTH.md` |
| Endpoint contracts | `API.md` |

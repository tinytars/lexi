# Security model

What this application promises, what it does not, and where the gaps currently are. Written 2026-08-24
(W72); previously this existed only in commit messages and per-file comments, which is not somewhere a
reviewer can find it.

**This document is honest about open gaps.** Two of them are exploitable today and are named below.
That is deliberate: a security document that lists only solved problems is marketing.

## The central claim

**The operator cannot read a patient's record.** Everything else here serves that.

A patient's vault is encrypted in the browser under a per-vault DEK (AES-GCM-256). The DEK never
leaves the browser in the clear — it is wrapped per principal (ECDH-ES → AES-GCM) into an *envelope*
stored in D1. The server holds ciphertext and envelopes; it can prove who may ask for a blob, and it
cannot open one.

The claim is verified rather than asserted: `tests/unit/auth-client-crypto.test.ts` captures the
signup payload and **decrypts it**, so a change that keeps every field name and breaks the
cryptography fails the suite.

### Key custody

| Principal | Holds | Can decrypt |
|---|---|---|
| Patient | Private key wrapped under a KEK derived from their password/passkey (PBKDF2-SHA256, 200k) | Yes |
| Clinician / support | An envelope minted by the patient, time-boxed for support | While the grant is live |
| Org (recovery) | An envelope minted at signup, revocable by the patient | Unless revoked |
| Operator | Nothing | **No** |

A Google-signup account is the deliberate exception: the server wraps that account's private key under
a per-account server KEK (HKDF over `GOOGLE_KEK`), because there is no password to derive from. Those
accounts are **server-custody** and the table above does not hold for them. This is a real,
intentional asymmetry, not an oversight.

## Boundaries and what enforces them

- **Session** — a signed cookie (HMAC-SHA256, 30-day TTL). Revocable since W71: `requireSession`
  checks `accounts.sessions_valid_from` on every authenticated request, so logout, a password change
  and a passkey removal all invalidate cookies already issued.
- **Authorisation** — `getEnvelope` refuses an envelope whose provider link is revoked, expired, or
  absent. The check lives in the accessor, not in each route, because it was previously in the routes
  and one of them forgot.
- **Vault writes** — conditional (`If-Match` → 412). The browser path *requires* a precondition (428
  without), because the live R2 copy is the only copy.
- **Rate limiting** — **none.** See gaps.
- **Transport** — Cloudflare TLS; `Secure`, `HttpOnly`, `SameSite=Lax` on every cookie.

## Known gaps, unfixed

1. ~~**`/api/raw` and `/api/document-extract` are authenticated but not authorised.**~~ **Closed
   2026-08-25 (W73).** All five handlers now resolve who owns the client namespace before touching R2
   (`functions/_lib/raw-owner.ts`), and answer **404 rather than 403** so a refusal does not confirm the
   object exists. `document-extract` GET is checked *above* its cache branch, which used to return
   another patient's extracted plaintext before it ever reached `raw/`. A **clinician with a live grant
   still reads their patient's files** — authorisation is their envelope, decided by the same
   `getEnvelope` accessor the vault route uses, so link expiry is not re-implemented. Ownership is
   resolved **by namespace, not by exact key**, or an attacker could PUT a new filename into someone
   else's folder and own it. `DELETE` now removes the ownership row with the object.
   **Two things a reviewer should know rather than infer:**
   - **The relationship is checked in BOTH directions**, and that is a correctness fix rather than a
     convenience. `raw_objects` is first-writer-wins, and the first writer into a patient's namespace is
     very often *not* the patient — a clinician drilled in on their behalf uploads a report first, and is
     recorded as owner. Checking only "can the caller read the recorded owner's vault" then denies the
     **patient** their own files. Caught by `main`'s e2e, which starts from an empty database and lets
     write order decide; dev's backfill had masked it by attributing every namespace to the true vault
     owner. Widening to both directions grants nothing new — a live provider link already means each
     side can open the other's relevant vault.
   - **An UNCLAIMED namespace is allowed, deliberately.** Ownership recording began with migration 0008,
     so pre-existing objects were attributed by `scripts/raw-backfill.ts`, which resolves a namespace by
     decrypting the vault with the org key — impossible for a patient who **revoked org recovery**. On
     dev that leaves exactly one object. Refusing unclaimed reads would take that patient's own
     attachment away from them to protect nobody, since an unclaimed namespace has no owner at risk. The
     residual is that an authenticated stranger who *guesses* an unclaimed client key can read it; it
     self-heals, because the first write claims the namespace.
   - **DELETE is the exception, since W75.** Every clause of the argument above is about a read or about
     a first write that claims the namespace — a delete is neither. There is no first deleter, nothing
     self-heals, and the bytes destroyed are plaintext PHI with no undo. `DELETE /api/raw/{id}/{file}`
     therefore requires `owner` or `granted` (`mayDestroy` in `functions/_lib/raw-owner.ts`); until then
     it tested only for `denied`, so on prod — which had no backfill when it shipped, making every
     namespace unclaimed the moment objects appeared — any signed-up account could destroy any
     patient's originals.
   - **The residual is now counted, not assumed.** Every route that calls `rawAccessFor` logs
     `access: owner | granted | unclaimed` on its outcome. The comment in `raw-owner.ts` claimed this
     before W75 and it was false: no route recorded the access kind anywhere. `chat-history` GET
     likewise carried a comment describing a read refusal it did not perform; the read stays permissive
     (a pre-W73 chat blob is unclaimed for exactly the patients the backfill cannot attribute, and it is
     ciphertext in any case) and the comment now says so.
   - **The backfill has run on both stores** (2026-08-26): dev 106 of 107, prod **35 of 35 with zero
     orphans**. Every live object is now attributed to an owner, so the "unclaimed is allowed" residual
     above currently applies to exactly one object on dev and none on prod.

2. ~~**`chat-history` PUT is unscoped**~~ **Closed 2026-08-25 (W73)**, by the same helper and the same
   rule — it is the same client namespace. A successful write claims the namespace, so a patient whose
   first action is a conversation (rather than an upload) owns their own history; without that their own
   chat would have read as unclaimed.

3. **No rate limiting on any route.** Credential submission and the salt lookups can be hit as fast as
   the network allows. A working KV-backed implementation exists in history (`68ab66b`, `ad0fabd`) and
   was reverted for an unrelated dev-server crash; see `docs/health-dash/plans/71`.
4. ~~**Account and PHI deletion do not exist.**~~ **Closed 2026-08-25 (W72).**
   `POST /api/account/erase` deletes the caller's vault blob, chat history, original uploads, extracted
   text, envelopes, grants in both directions, credentials, identities and public keys, then tombstones
   the account row. `regenLog` (added in the same milestone) lives inside the vault blob and goes with
   it. Two things a reviewer should know rather than infer:
   - **The account row survives as a tombstone**, with every personal field NULLed. `phi_access_events`
     points at it, and deleting the row would make a *different* patient's audit trail unattributable.
   - **Corrected 2026-08-25 (W73).** Two things were wrong: the R2 listing that counts leftover objects
     did not follow the cursor, so on a store over 1000 objects it stopped early and could report
     `complete: true` for an incomplete erasure; and `recovery_grants` — which holds a vault's DEK
     wrapped under a recovery code — was never deleted, leaving a key to a record that had just been
     erased. The second was found by extending the completeness test to derive D1 tables from the
     migrations, the same way it already derived R2 key classes.
   - **Erasure is complete only for objects written after migration 0008.** Originals under `raw/` and
     `text/` written before it have no ownership row, so the server cannot prove whose they are; the
     route counts them as `unattributable` and returns `complete: false` rather than reporting success.
     Gap 1 below is what makes that necessary, and migration 0008's `raw_objects` table is the primitive
     that will close it.
   - **W75 — the count is scoped to the erased account's own namespaces.** It used to be every unowned
     key under `raw/`/`text/` store-wide, which was wrong twice over: another patient's pre-0008
     originals made this erasure read incomplete, and — because ownership is first-writer-wins — an
     object a *clinician* wrote about this patient carried the clinician's owner row, so it was neither
     deleted nor counted and the subject was told `complete: true` while that PHI survived. The count is
     now everything under this account's namespaces that the erasure did not delete, owned or not.
6. ~~**A session cookie alone can add a login method, and an email change is never announced to the
   address losing it.**~~ **Closed 2026-08-25 (W73 Phase A).** Adding a passkey or a Google identity now
   runs the same `step_up_required` challenge that replacing a password already ran
   (`functions/_lib/step-up.ts`, one implementation shared by all three), an email change stamps
   `accounts.email_changed_at` and **notifies the address being replaced**, and every added method sends
   a notice. **One residual, by construction:** an account whose only login method is Google has no
   secret to challenge, so it is allowed and notified rather than refused — refusing would make a
   legitimate flow impossible. The notice is the control there, not a courtesy. Original finding:
   - Adding a **password** *does* now require proving the current one (`account/methods.ts:105-114`,
     `step_up_required`), and every credential change revokes outstanding sessions (W71). The
     documented exception is a passkey- or Google-only account setting its *first* password, where
     there is no current password to prove and nothing is being destroyed.
   - Adding a **passkey** (`account/methods/passkey/verify.ts:50`) or a **Google** identity
     (`account/methods/google.ts:33`) requires only `requireSession`. A stolen cookie can therefore
     mint a credential the owner never sees — one that outlives the cookie itself.
   - `PATCH /api/account` sends a verification link to the **new** address and tells the **old** one
     nothing (`account.ts:81-86`), so the owner has no signal that it happened.
   Chained, that is a silent, permanent account takeover from one captured cookie. Closing it means a
   step-up ceremony for *adding* a method (not just replacing a password) and a notice-to-old-address
   on email change.
7. **Prod has never been backed up.** All snapshots are `store=dev`. The restore drill passes — for
   dev. **And dev's own nightly snapshot was failing for five consecutive nights** (2026-08-20 to
   2026-08-24), refusing to run on a `text/` sidecar key `classifyKey()` had never been taught. Fixed
   in `0d0f29f`; the first run that should succeed is 2026-08-25 03:15 local — **verify it before
   treating dev as backed up.** The refusal itself was correct behaviour (a backup that silently skips
   a key class is the worse failure), and the alarm fired every night; what did not happen is anyone
   reading it.

## Deliberate non-goals

- **A clinician can reset their patient's account, not merely read it.** W73 lets a clinician with a
  live link issue a one-time recovery code (`POST /api/recovery/grant`). It gives them no new *read*
  access — they already hold the DEK, which is what provider access means — but whoever holds the code
  can replace the account's keypair, so read access becomes account control. Accepted because the
  alternative is a locked-out patient with no route back in at all. Bounded by: clinician only (never
  support, `recovery:issue`), a live-link re-check at issue time, five attempts, one hour, single use,
  the wrapped blob destroyed on consumption or expiry, an audit row naming the issuer, and an email to
  the patient when it is redeemed. **The code is never emailed** — see RECOVERY.md I2 for why that would
  break the central claim above rather than merely bend it.

- **The org recovery envelope is now reachable — by a person, never by a route.** W73 added
  `scripts/recovery-approve.ts`, which uses it to issue a recovery code for a patient with no code and
  no clinician. It is a CLI requiring `ORG_KEY_PASSPHRASE`, and `recovery-invariants.test.ts` asserts
  that nothing under `functions/` can load that key — so the capability exists for an operator at a
  keyboard and not for a request. A patient who revoked org recovery is refused, with no override.

- **The org recovery envelope is not zero-knowledge.** A patient who loses their password can be
  recovered, which means the org *can* decrypt unless the patient revokes that envelope. This is a
  chosen trade against permanent, unrecoverable data loss for a patient population that will lose
  passwords. `orgRecoveryRevokedAt` is the patient's opt-out.
- **Raw uploads are stored unencrypted.** Originals live in R2 as plaintext PHI, gated by session.
  Encrypting them is possible; it has not been done.
- **PHI is committed to this repository.** `apps/health-dash-web/records/private/` holds real patient
  data and is in git history. If this repo ever goes public, that history must be purged, not merely
  deleted at HEAD — see the root `CLAUDE.md`. Plaintext PHI cannot be rotated.

## Cryptographic choices

| Purpose | Primitive |
|---|---|
| Vault / chat / attachment blobs | AES-GCM-256, 12-byte IV, `HD1` envelope |
| Password / recovery KEK | PBKDF2-SHA256, 200,000 iterations, 16-byte salt |
| DEK wrapping | ECDH-ES (P-256) → AES-GCM-256 |
| Sessions and signed cookies | HMAC-SHA256 |
| Passkeys | WebAuthn, with a PRF-derived KEK |

All via WebCrypto (`SubtleCrypto`) in browser, Worker and CLI. No hand-rolled primitives.

**One secret, five token types.** `SESSION_SECRET` signs sessions, email-verification tokens, WebAuthn
challenges, the Google OAuth state cookie and the Google link cookie, with no purpose claim separating
them. Rotating it therefore signs everyone out *and* invalidates every in-flight verification. Adding
a purpose claim is a known improvement, not yet made.

## Reporting

Private repository; report to the owner directly. There is no external disclosure process because
there are no external users yet — that changes at the public split (`docs/cross-app/10`), and this
section must change with it.

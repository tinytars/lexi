# CUTOVER.md — moving beta users from dev to prod

The runbook for the one irreversible-feeling step: `health-dash-dev` currently holds the live
beta users' vaults, and `health-dash-main` must take them over. Written before the window, to be
followed *during* it — the point of a runbook is that nothing is decided under time pressure.

**Read BACKUP.md first.** This procedure copies live PHI. It must not start without a snapshot whose
restore has actually been exercised, because the rollback below depends on dev being untouched, and
"untouched" is a claim a backup should be able to check.

## Why a naive `r2 cp` is wrong

R2 and D1 are two halves of one secret, and the halves reference each other:

- `vault_envelopes.wrapped_dek` (D1) holds the **wrapped DEK**; the ciphertext it opens lives in R2.
- `vaults.r2_key` (D1) names the object that DEK opens.

Copy either side alone and you get vaults nobody can open — including the owner, including the org.

**`r2_key` is a bare object name, not a path — do not rewrite it.** It holds `data-<client-id>.enc`,
and the store prefix is composed at *read* time by `storeKey()` (`functions/_lib/store.ts:13`) and
`r2KeyFor()` (`scripts/vault-sync.ts:41`) from the branch's `STORE_PREFIX`. So the `dev/` → `prod/`
prefix change is entirely an **R2 key** change; D1 needs no rewrite at all.

Earlier revisions of this file said the opposite — that `r2_key` "stores the R2 key path itself" and
every copied one needs its prefix rewritten. Following that would have written
`prod/data-<client-id>.enc` into `r2_key`, and `storeKey` would then have looked for
**`prod/prod/data-<client-id>.enc`**: every
migrated vault unopenable, which is precisely the failure this section exists to prevent. Corrected
2026-08-13.

## Preconditions

- [ ] `npm run doctor:prod` is fully green (no ✗). In particular prod has every secret; a missing one
      surfaces post-cutover as a broken route on a user's account.
- [ ] `literacy.tinytars.foundation` is bound to `health-dash-main` and serving, and `WEBAUTHN_ORIGIN`
      matches it exactly. Do not cut over onto the `pages.dev` hostname. The zone is still on Google
      DNS. Proof is a passkey
      registered *and* used to sign in on that hostname, not a green DNS lookup.
- [ ] Every account being migrated has an **org recovery envelope**. An
      account without one is a vault the org can never migrate or prove restorable, and it cannot be
      fixed server-side afterwards. **Two accounts fail this and are deliberately excluded** (audited
      2026-08-13): `6e4de08e…` "Deprecated Admin" — passkey-only *and* envelope-less, so it could not
      sign in post-cutover either — and `d59c9b0c…` "sekhar101", email unconfirmed. Both vaults are
      empty shells (182 and 192 bytes). Both accounts are marked `lifecycle_stage='churned'` on dev
      and stay there. **So the migration set is 6 accounts, not 8, and 3 vaults, not 5.** The
      row-count check below must be read against that, or it fails as a surprise.
- [ ] The vault tooling can actually address prod. `scripts/vault-sync.ts`, `vault-snapshot.ts`,
      `org-d1.ts`, `access-log.ts` and `rotate-pilot-credentials.ts` hardcoded `health-vault` /
      `health-identity-dev` until 2026-08-13; they now derive the target from the worktree's
      `wrangler.jsonc` like `scripts/d1-migrate.sh` does. **Run step 5 from the `main` worktree** —
      the worktree you stand in decides which environment you touch. Without this there is no tool
      that can read prod's bucket, and step 5 cannot be performed at all.
- [ ] A fresh snapshot exists (`npm run vault:snapshot`) and `npm run vault:snapshot:check` is green.
- [ ] The restore drill in BACKUP.md has been run at least once against this snapshot format.
- [ ] Prod D1 is baselined `0001…0006` and holds **no rows** except the org operational key
      (`00000000-…-0001`). `0002_seed_migrated_accounts.sql` seeds guessable credentials on a
      fresh database — the migration record stays, the seeded data does not.
- [ ] Beta users have been told the freeze window, and that **they will need to re-register their
      passkeys afterwards** (see below).

## The passkey consequence — say this out loud beforehand

Passkey credentials are bound to the RP ID they were registered under (`_lib/webauthn.ts:90,116`).
Beta users registered against `health-dash-aex.pages.dev`. The D1 copy faithfully brings their
`credentials` rows to a host those credentials were never scoped to, so **every migrated passkey is
dead on arrival** regardless of what prod's `WEBAUTHN_RP_ID` is set to.

This is not a bug to fix in the copy step — it is a property of WebAuthn. Plan for it:

- Users sign in at prod with **password or Google**, then re-register a passkey.
- An account whose *only* identity is a passkey cannot sign in at all after the move. Enumerate those
  before the window (`identities` rows with `method='passkey'` and no sibling `password`/`google` row
  for the same `account_id`) and get each of them a second factor **before** freezing.

## Sequence

1. **Announce and freeze.** Put dev into read-only for the window. The beta userbase is small, which
   is exactly why a freeze beats dual-write — the coordination cost is minutes, and dual-write would
   double every write path for weeks.
2. **Snapshot** (BACKUP.md Phase 1). This is the rollback's foundation, not a formality.
3. **Copy R2**: for the migrated accounts, every `dev/…` object in `health-vault` → the same name
   under `prod/…` in `health-vault-prod` — `data-*`, `chat-*`, `raw/` and `processed/`. **Exclude
   `dev/logs/`**: that is dev's audit trail and it belongs to dev. Copy, never move — dev must remain
   byte-identical, because that is what the rollback rests on.
4. **Copy D1**: export the migrated accounts' rows from `health-identity-dev` and import them into
   `health-identity-prod` in FK-safe order — `accounts` → `identities`, `credentials`, `public_keys`
   → `vaults` → `vault_envelopes` → `provider_links`. **Carry `vaults.r2_key` verbatim** (see "Why a
   naive `r2 cp` is wrong" — it is a bare object name; rewriting it double-prefixes the lookup and
   breaks every vault) and `vault_envelopes.wrapped_dek` verbatim too, since `wrapped_dek` is content,
   not location. Do **not** re-insert the org operational account `00000000-…-0001`; prod already has
   it. Do carry its envelope rows.
5. **Decrypt every blob in prod.** Not a sample. **Run this from the `main` worktree**, so the tooling
   resolves prod's bucket and database out of that branch's `wrangler.jsonc`. For each `vaults` row:
   fetch `r2_key` from the prod bucket, open it with the org envelope, confirm it parses. This is the
   step that proves the two halves still match; everything before it is plumbing. Assert no `r2_key`
   contains a `/` while you are here — that is the double-prefix bug in one grep.
6. **Unfreeze.** The hostname flip this step used to describe is already done —
   `literacy.tinytars.foundation` has been bound to `health-dash-main` since the zone migration. What
   remains is directing users there, and keeping `health-dash-aex.pages.dev` alive as the rollback
   target until prod has been stable long enough to retire it deliberately.

## Rollback — decided now, not then

**If verification (step 5) fails for even one vault: stop. Do not repair prod.**

- Unfreeze **dev**, unchanged. It was never written to; steps 3 and 4 are copies.
- **Discard prod's data** — delete the copied R2 objects and truncate the D1 tables back to the
  org operational key only. Prod returns to the empty state described in Preconditions.
- Diagnose offline, with dev serving users normally, and re-run the whole sequence from step 1.

The reason to write this down in advance: a half-migrated prod is repairable in principle, and under
pressure that is exactly the tempting, wrong move. A vault whose D1 row and R2 object disagree is
unopenable by anyone — there is no operator override, by design (VAULT.md §2). Discarding a copy
costs one more freeze window; repairing one badly costs a patient's records.

## Post-cutover verification

- [ ] Every `vaults.r2_key` in prod D1 resolves to an object that exists in `health-vault-prod`, and
      every one of those objects decrypts. No `r2_key` contains a `/`.
- [ ] Row counts match dev's **for the migrated set only** across `accounts`, `identities`,
      `credentials`, `public_keys`, `vaults`, `vault_envelopes` — 6 accounts plus the org key, and 3
      vaults. Comparing raw totals will show a legitimate shortfall, because two accounts are
      deliberately excluded (see Preconditions).
- [ ] A real user signs in on the prod hostname via password/Google and registers a new passkey.
- [ ] `POST /api/chat` with no session returns 401 on prod — proves bindings and secrets are live,
      rather than static assets being served by a Function-less deploy.
- [ ] Dev still serves and still decrypts. It is the rollback target until prod has been stable long
      enough to retire it deliberately.

# 0001 — Rewrite an applied migration in place

**Context.** `migrations/0002_seed_migrated_accounts.sql` published, from 2026-09-14 to 2026-10-06 in
a public repository, an EC P-256 private key for each of three real accounts wrapped under that
account's own slug, with the slug printed in plaintext on an adjacent line — plus each vault's wrapped
DEK. It is also applied history on both live databases, and wrangler's ledger tracks applied
migrations by name: deleting the file makes the ledger name a file that is not there and breaks
`scripts/e2e-serve.sh:3,89` and `tests/unit/node-host.test.ts:47`, while renaming it makes the ledger
replay it.

**Decision.** The file is rewritten in place, keeping its name, to seed four synthetic principals — the
org operational account, one provider and two patients on its roster — and to carry no `credentials`
row, no `vaults` row and no `vault_envelopes` row at all. The four keypairs were generated when the
file was written and only their public halves kept, so it holds no wrapped key material in either
direction. `0011` and `0012`, which existed only to correct rows `0002` no longer seeds, become
comment-only no-ops and lose the real vault, account and `provider_links` identifiers they were scoped
by. From this commit the tracked files permanently do not describe what either live database ran.

**Why.** Rewriting it is the only option that both ends the publication and leaves the migration chain
intact, and the loss it causes is a record that was never load-bearing: what the live databases
actually ran is recorded in `planning/lexi/remediate-published-key-material.md`, in each migration's
own header, and in git history, while what a *fresh* database seeds is the only thing the file still
decides. Seeding no key material rather than synthetic key material is the narrower choice on purpose:
a wrapped key beside its KDF parameters is precisely the shape the protocol's credentials guard now
refuses, and the alternative was an allow-list entry for this one path — which would re-open the blind
spot in the single file whose history proves it matters. A loginable local account comes from
`scripts/provision-support-account.ts` and a local vault with real envelopes from
`scripts/provision-e2e-patient.ts`, which round-trips its own crypto in a unit test rather than asking
anyone to trust a seeded blob.

-- 0002_seed_migrated_accounts.sql — the seed principals a fresh local database starts with.
--
-- REWRITTEN 2026-10-06, AND THAT IS THE POINT OF THE FILE. From 2026-09-14 to 2026-10-06 this
-- migration seeded three real accounts of one household and published, for each of them, an EC
-- P-256 private key wrapped under that account's own slug — with the slug printed in plaintext on
-- an adjacent line of this same file — plus the wrapped DEK of each account's vault. tinytars/lexi
-- is a public repository, so that was a complete decryption path to real health records needing no
-- secret at all. Every key named here before this rewrite is replaced and dead; the thumbprints are
-- recorded in scripts/compromised-public-keys.json, which is what refuses an envelope to one of
-- them. docs/adr/0001-rewrite-applied-migration-0002.md is why this file was rewritten in place
-- rather than deleted or superseded.
--
-- WHAT IS DELIBERATELY NOT HERE, WHICH IS MOST OF WHAT USED TO BE. No credentials row, no vault and
-- no vault_envelopes row. The four keypairs below were generated when this file was written and only
-- their PUBLIC halves were kept — the private halves were never serialized anywhere — so there is no
-- wrapped key material in this file at all, in either direction. That is not fixture thrift: a seed
-- carrying a wrapped key beside its KDF parameters is the exact shape the protocol's credentials
-- guard now refuses (guards/credentials-guard.sh, wrapped_key), and an allow-list entry for this one
-- path would re-open the blind spot in the one file whose history proves it matters. A loginable
-- local account comes from scripts/provision-support-account.ts and a local vault with real
-- envelopes from scripts/provision-e2e-patient.ts, which round-trips its own crypto in
-- tests/unit/provision-e2e-patient.test.ts rather than asking anyone to trust a seeded blob.
--
-- SO WHAT A FRESH DATABASE GETS: the org operational principal, which functions and scripts refer to
-- by the fixed id below and whose public_keys row several foreign keys require; one provider with a
-- roster of two patients, which is the shape the roster and provider-drill-in routes are written
-- against; and nothing anybody can sign in as. 0011 and 0012 are historical no-ops against it and
-- say so in their own headers.

INSERT INTO accounts (id, email, email_confirmed, display_name, lifecycle_stage, provider_kind, created_at) VALUES ('00000000-0000-4000-8000-000000000001', NULL, 0, 'Org Operational Key', 'active', NULL, '2026-07-07T00:00:00Z');
INSERT INTO public_keys (account_id, public_key_jwk, created_at) VALUES ('00000000-0000-4000-8000-000000000001', '{"key_ops":[],"ext":true,"kty":"EC","x":"Nf08BA6eeDcBkShc1V-fnWNRktPdQG5OjY_Db_bBGII","y":"7rxTJH-9cdGTcWZOcJa8kigw6vyoJCGCV9_aWc2XXaM","crv":"P-256"}', '2026-07-07T00:00:00Z');

INSERT INTO accounts (id, email, email_confirmed, display_name, lifecycle_stage, provider_kind, created_at) VALUES ('5eedc000-0000-4000-8000-00000000c000', 'seed-provider@local.invalid', 1, 'Seed Provider', 'active', 'primary', '2026-07-07T00:00:00Z');
INSERT INTO identities (id, account_id, method, provider_subject, credential_id, created_at) VALUES ('5eed1c00-0000-4000-8000-00000000c000', '5eedc000-0000-4000-8000-00000000c000', 'password', 'seed-provider@local.invalid', NULL, '2026-07-07T00:00:00Z');
INSERT INTO public_keys (account_id, public_key_jwk, created_at) VALUES ('5eedc000-0000-4000-8000-00000000c000', '{"key_ops":[],"ext":true,"kty":"EC","x":"DWOpR0l73KPerftLqu7_gWvlC_Rua8Jbu-kNBC17CpQ","y":"geOw38-c5cfQgaFjv41TwS8BrDahP53WudKbrtBivpw","crv":"P-256"}', '2026-07-07T00:00:00Z');

INSERT INTO accounts (id, email, email_confirmed, display_name, lifecycle_stage, provider_kind, created_at) VALUES ('5eed0a00-0000-4000-8000-0000000000a0', 'seed-owner-a@local.invalid', 1, 'Seed Owner A', 'active', NULL, '2026-07-07T00:00:00Z');
INSERT INTO identities (id, account_id, method, provider_subject, credential_id, created_at) VALUES ('5eed1a00-0000-4000-8000-0000000000a0', '5eed0a00-0000-4000-8000-0000000000a0', 'password', 'seed-owner-a@local.invalid', NULL, '2026-07-07T00:00:00Z');
INSERT INTO public_keys (account_id, public_key_jwk, created_at) VALUES ('5eed0a00-0000-4000-8000-0000000000a0', '{"key_ops":[],"ext":true,"kty":"EC","x":"GWsbuh8F6NwaAuX8_6EriT-D6DYI-Fjghexv0Ol13_Y","y":"VLcGTWWrouufyR4rsfNVc5Jmk1GrhrcZ4E_vOrNbwt0","crv":"P-256"}', '2026-07-07T00:00:00Z');

INSERT INTO accounts (id, email, email_confirmed, display_name, lifecycle_stage, provider_kind, created_at) VALUES ('5eed0b00-0000-4000-8000-0000000000b0', 'seed-owner-b@local.invalid', 1, 'Seed Owner B', 'active', NULL, '2026-07-07T00:00:00Z');
INSERT INTO identities (id, account_id, method, provider_subject, credential_id, created_at) VALUES ('5eed1b00-0000-4000-8000-0000000000b0', '5eed0b00-0000-4000-8000-0000000000b0', 'password', 'seed-owner-b@local.invalid', NULL, '2026-07-07T00:00:00Z');
INSERT INTO public_keys (account_id, public_key_jwk, created_at) VALUES ('5eed0b00-0000-4000-8000-0000000000b0', '{"key_ops":[],"ext":true,"kty":"EC","x":"q27YrmxZwT1nQvWA321g9BAsFVVEN0ERBIDhx80knAg","y":"fUsIkjNMC8XpLWyB_zC91oYITfYDz__h-9qEE5fHAZw","crv":"P-256"}', '2026-07-07T00:00:00Z');

-- The roster. 'primary' is the Role literal functions/_lib/capabilities.ts checks; 0012 exists
-- because this file used to seed 'clinician', which that table has never recognised.
INSERT INTO provider_links (id, patient_account_id, provider_account_id, role, status, consent_ref, granted_by, granted_at) VALUES ('5eed11a0-0000-4000-8000-0000000000a0', '5eed0a00-0000-4000-8000-0000000000a0', '5eedc000-0000-4000-8000-00000000c000', 'primary', 'active', 'seed', '5eedc000-0000-4000-8000-00000000c000', '2026-07-07T00:00:00Z');
INSERT INTO provider_links (id, patient_account_id, provider_account_id, role, status, consent_ref, granted_by, granted_at) VALUES ('5eed11b0-0000-4000-8000-0000000000b0', '5eed0b00-0000-4000-8000-0000000000b0', '5eedc000-0000-4000-8000-00000000c000', 'primary', 'active', 'seed', '5eedc000-0000-4000-8000-00000000c000', '2026-07-07T00:00:00Z');

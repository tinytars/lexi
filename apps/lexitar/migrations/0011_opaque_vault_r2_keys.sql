-- 0011_opaque_vault_r2_keys.sql — G1: the two pilot vaults stop being named after their patient.
--
-- `r2_key` is the identifier at every layer at once: it is the R2 object name, the `/api/vault/{id}`
-- route segment (functions/api/vault/[id].ts looks the route up BY r2_key, not by vault_id), and the
-- name of the served static asset. So while the ciphertext was always sound, `data-alex.enc` was
-- reachable unauthenticated at a guessable URL and the filename alone disclosed who the patient was.
--
-- The scheme replacing it is not new: every account created since signup shipped is already keyed by
-- its own lowercased account id (src/App.svelte, createFirstClient). This backfills the two pilots
-- onto it, matching the renamed records/public/data-{id}.enc blobs and records/private/{id}/ dirs.
--
-- 0002 is left exactly as it was — it is applied history, and its INSERT is a true record of what was
-- seeded. Scoped by vault_id rather than by the old key so this can never touch a vault that
-- /api/vault/rotate has since moved to a fresh uuid.

UPDATE vaults SET r2_key = 'data-834bc60d-c937-467d-9e78-3caa734acf45.enc'
 WHERE vault_id = 'da7e1421-53b0-499b-be5d-a5d910c676f5';

UPDATE vaults SET r2_key = 'data-7de3dfed-c872-4971-a923-c85d3322c087.enc'
 WHERE vault_id = '6205f9cd-bbe3-42ed-8229-57f9319e9855';

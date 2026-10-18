-- 0010_rotation_staging.sql — W75. A DEK rotation used to re-encrypt the vault IN PLACE: the browser
-- PUT the blob under the new DEK and only committed the matching envelopes several round trips later.
-- An interruption in that window left every principal's envelope wrapping a key the ciphertext no
-- longer used — an unrecoverable lockout with no signal until the next unlock failed.
--
-- The rotation now writes to a NEW r2 key and the envelope swap doubles as the pointer swap. This
-- column holds the key that has been reserved for the in-flight rotation, so the vault PUT guard can
-- authorise a write to an object no vault row points at yet.
ALTER TABLE vaults ADD COLUMN rotation_staging_r2_key TEXT;

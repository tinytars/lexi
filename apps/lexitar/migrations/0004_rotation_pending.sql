-- 0004_rotation_pending.sql — W44 P4c. When a support grant EXPIRES (server-side, patient offline) the
-- vault can't be re-keyed synchronously under zero-knowledge, so it's flagged here; the patient's next
-- login performs the client-side DEK rotation and clears the flag.
ALTER TABLE vaults ADD COLUMN rotation_pending INTEGER NOT NULL DEFAULT 0;

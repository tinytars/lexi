-- 0006_org_recovery.sql — W55 P4. Durable record of a patient revoking org recovery, mirroring
-- rotation_pending (0004): a nullable flag set by the app, read back at unlock and in the account UI.
ALTER TABLE vaults ADD COLUMN org_recovery_revoked_at TEXT;

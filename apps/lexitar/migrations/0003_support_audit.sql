-- 0003_support_audit.sql — W44 P4b. Support consented-access needs a per-link expiry (time-boxed
-- grants, Open decision #2) and an FTC-HBNR (§I) PHI-access/disclosure audit log rich enough to scope
-- "which individuals were affected" — which crm_events (lifecycle-only) cannot serve. Still NO PHI.
ALTER TABLE provider_links ADD COLUMN expires_at TEXT;

CREATE TABLE phi_access_events (
  id                 TEXT PRIMARY KEY,
  actor_account_id   TEXT NOT NULL REFERENCES accounts(id),
  subject_account_id TEXT NOT NULL REFERENCES accounts(id),
  vault_id           TEXT,
  action             TEXT NOT NULL,
  consent_ref        TEXT,
  meta               TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_phi_access_subject ON phi_access_events(subject_account_id);
CREATE INDEX idx_phi_access_actor ON phi_access_events(actor_account_id);

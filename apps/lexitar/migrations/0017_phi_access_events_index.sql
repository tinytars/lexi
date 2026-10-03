-- The patient-visible access screen reads phi_access_events newest-first for one subject
-- (functions/api/account/access-events.ts). 0003 indexed subject_account_id alone, which was enough
-- while only /api/support/access wrote rows; privileged reads now write one row per object disclosed
-- (functions/_lib/phi-audit.ts), so the sort is what needs covering, not just the filter.
-- Additive and idempotent: no column changes, no data touched, droppable with no loss.
CREATE INDEX IF NOT EXISTS idx_phi_access_events_subject_created
  ON phi_access_events (subject_account_id, created_at DESC);

-- M93 Phase 1 — account-level display-unit preference, replacing the per-patient
-- Client.unitSystem field (a provider drilling into multiple patients needs their own
-- consistent preference, independent of whichever patient's vault they're viewing).
ALTER TABLE accounts ADD COLUMN unit_system TEXT;

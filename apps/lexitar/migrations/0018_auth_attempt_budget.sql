-- The per-window cap on password sign-in attempts and salt probes (functions/_lib/auth-budget.ts),
-- mirroring 0014_error_report_budget.sql. `bucket` is HMAC(SESSION_SECRET, "auth-budget:<kind>:<value>")
-- truncated to 8 bytes plus the window, with one "*:<window>" row for the global cap — so this table
-- holds no address, no email address and no health data. Nothing reads a row once its window has passed;
-- the writer prunes old ones opportunistically. Rotating SESSION_SECRET silently resets every bucket,
-- which forgets attempts rather than granting any.
-- `window_start` rather than `window`, which SQLite reserves for window functions.
CREATE TABLE IF NOT EXISTS auth_attempt_budget (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  n            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_attempt_budget_window ON auth_attempt_budget (window_start);

-- The hourly cap that replaces the session check on anonymous /api/client-error reports
-- (functions/_lib/report-budget.ts). `bucket` is HMAC(SESSION_SECRET, ip):<hour>, plus one "*:<hour>"
-- row for the global cap — never an address, which is PII here. Nothing reads a row after its hour;
-- the writer prunes old ones opportunistically.
CREATE TABLE IF NOT EXISTS error_report_budget (
  bucket TEXT PRIMARY KEY,
  hour   INTEGER NOT NULL,
  n      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_report_budget_hour ON error_report_budget (hour);

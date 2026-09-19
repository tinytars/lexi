-- W84 — which persona voices this account's chat answers and read-aloud. Account-level for the same
-- reason as unit_system (0005): a provider keeps their own voice across every patient they open.
-- NULL means "never chosen", which the app reads as the default persona.
ALTER TABLE accounts ADD COLUMN persona TEXT;

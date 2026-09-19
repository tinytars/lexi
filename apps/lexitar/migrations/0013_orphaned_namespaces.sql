-- 0013_orphaned_namespaces.sql — when each orphaned client namespace was first seen (W76).
--
-- An orphan holds objects with no raw_objects row, and every route refuses it
-- (functions/_lib/raw-owner.ts). Its owner can reclaim it; scripts/orphan-sweep.ts deletes what nobody
-- reclaims. The grace period needs a start date the objects themselves can't give — a legacy upload is
-- old the day it becomes an orphan — so the sweep records one here. Additive; nothing else reads it.

CREATE TABLE IF NOT EXISTS orphaned_namespaces (
  client_id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL
);

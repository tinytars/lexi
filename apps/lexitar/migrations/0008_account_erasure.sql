-- W72 — account erasure, and the ownership record that makes it possible.
--
-- TOMBSTONE, NOT ROW DELETE, for the account itself. Every other table here holds personal data and is
-- hard-deleted; `accounts` keeps one row carrying an opaque id, the erasure timestamp, and nothing
-- else. Three reasons, none of them "we might want it back":
--   1. `phi_access_events` records who read whose record. If the actor's row vanished, an access that
--      really happened would become unattributable — erasing a patient's account would quietly damage
--      a different patient's audit trail.
--   2. A deleted email must not be silently re-registerable into a stale grant graph without anyone
--      noticing that it once belonged to someone else.
--   3. An erasure that leaves no trace cannot be shown to have happened, which is the one thing a
--      subject who requested it is entitled to.
-- The tombstone is not personal data: email, display name and lifecycle stage are all nulled by the
-- same statement that sets `deleted_at`.
ALTER TABLE accounts ADD COLUMN deleted_at TEXT;

-- WHY A NEW TABLE JUST FOR RAW OBJECTS.
--
-- Original uploads live at {store}/raw/{clientId}/{file} and their extracted text at
-- {store}/text/{clientId}/{file}.json, where `clientId` is a patient's own display name for one of
-- their clients — a string that exists only inside the ENCRYPTED vault. The server has therefore never
-- been able to answer "which raw objects belong to this account", which is both why SECURITY.md gap 1
-- is open (any session can read any raw key) and why an erasure route could not previously promise to
-- delete a patient's original PDFs.
--
-- Recording ownership at write time is the missing primitive for both. This migration only creates the
-- table and the write path fills it; the read-side authorization check is deliberately a separate
-- change, because it has to handle objects written before this table existed and that is a migration
-- of live PHI rather than a code change.
--
-- Objects written BEFORE this table cannot be attributed, and erasure reports them as such rather than
-- claiming a completeness it does not have.
CREATE TABLE IF NOT EXISTS raw_objects (
  r2_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_objects_account ON raw_objects(account_id);

-- W73 — account recovery, and the one thing that has to be true before any of it is trustworthy.
--
-- ── accounts.email_changed_at ────────────────────────────────────────────────
-- Every recovery notice and every emailed code goes to `accounts.email`. Until now a stolen session
-- cookie could change that address through PATCH /api/account and the OLD address was told nothing
-- (functions/api/account.ts:81-86), so an attacker could quietly redirect every future recovery message
-- to a mailbox they control. That is why the gap-5 work lands before the recovery work rather than
-- after it: an emailed code is only as trustworthy as the mailbox it is sent to.
--
-- The column is what lets a route say "this address is too new to be trusted for recovery yet". NULL
-- means the address has never been changed, which is the state every existing row starts in.
ALTER TABLE accounts ADD COLUMN email_changed_at TEXT;

-- ── recovery_grants ──────────────────────────────────────────────────────────
-- A clinician who already holds a patient's DEK re-wraps it under a fresh one-time code and READS THE
-- CODE TO THE PATIENT — Apple's recovery-contact model, where the contact reads you a code rather than
-- approving a request. The server stores and serves the blob and cannot open it, exactly like
-- `vault_envelopes`.
--
-- There is no emailed-delivery option, and that is a decision rather than an omission: for the server
-- to put the code in an email it must be given the code, and it already holds `wrapped_dek`. Anything
-- holding both can open the record, so emailed delivery would make the operator briefly able to read a
-- patient's record — SECURITY.md's central claim, not a secondary invariant. Spoken delivery also makes
-- the identity check structural: the code cannot reach the patient without the conversation happening.
--
-- A ROW, NOT A SIGNED TOKEN. A signed token is stateless and therefore replayable until it expires, by
-- construction — there is nowhere to record that it was used. One-time use here is a compare-and-swap:
-- UPDATE ... SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL, then check rows-changed. D1 has
-- no transactions outside batch(), so that conditional UPDATE *is* the lock.
CREATE TABLE IF NOT EXISTS recovery_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),

  -- iv‖AES-GCM(PBKDF2(code, kdf_params.salt), raw DEK). NULLABLE ON PURPOSE, and cleared the moment the
  -- grant is consumed or found expired.
  --
  -- This blob is the actual attack surface, not the verifier below: anyone holding it can try candidate
  -- codes against it offline, and AES-GCM's tag tells them when they succeed — no server, no attempt
  -- counter, no expiry involved. Everything else here bounds the ONLINE attack; only deleting the blob
  -- bounds the offline one. So it exists for at most the grant's lifetime and then stops existing.
  wrapped_dek BLOB,
  kdf_params TEXT NOT NULL,

  -- SHA-256(deriveAuthHash(code, salt)) — NOT SHA-256(code).
  --
  -- The distinction is the whole point. A code short enough to read down a phone line is ~60 bits; a
  -- plain SHA-256 of it falls to an offline sweep in minutes for anyone who can read this table. Going
  -- through the same PBKDF2/200k domain-separated derivation the password and recovery credentials use
  -- puts that sweep out of reach, and costs the server nothing — it only ever hashes what the client
  -- already derived.
  code_verifier_sha256 TEXT NOT NULL,

  issued_by TEXT NOT NULL REFERENCES accounts(id),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,

  -- What makes a phone-readable code acceptable at all. Apple's HSMs destroy the escrow record after
  -- ten guesses; this column is the equivalent, and without it the code is an unlimited oracle.
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_recovery_grants_account ON recovery_grants(account_id);

-- At most one live grant per account. Two live grants would let a patient hold a stale code that still
-- opens the record after a second was issued for a reason the first was not, and would make "which
-- grant did this attempt belong to" ambiguous — which is what the attempt counter counts against.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_grants_one_live
  ON recovery_grants(account_id) WHERE consumed_at IS NULL;

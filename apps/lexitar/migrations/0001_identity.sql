-- 0001_identity.sql — W44 P0 identity / relationship / CRM store. NO PHI.
CREATE TABLE accounts (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE,
  email_confirmed INTEGER NOT NULL DEFAULT 0,
  display_name    TEXT NOT NULL,
  lifecycle_stage TEXT NOT NULL DEFAULT 'active',
  provider_kind   TEXT,
  created_at      TEXT NOT NULL
);
CREATE TABLE identities (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  method           TEXT NOT NULL,
  provider_subject TEXT,
  credential_id    TEXT,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_identities_provider ON identities(method, provider_subject) WHERE provider_subject IS NOT NULL;
CREATE UNIQUE INDEX idx_identities_credential ON identities(credential_id) WHERE credential_id IS NOT NULL;
CREATE INDEX idx_identities_account ON identities(account_id);
CREATE TABLE credentials (
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  method              TEXT NOT NULL,
  wrapped_private_key BLOB NOT NULL,
  kdf_params          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (account_id, method)
);
CREATE TABLE public_keys (
  account_id     TEXT NOT NULL PRIMARY KEY REFERENCES accounts(id),
  public_key_jwk TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE TABLE vaults (
  vault_id         TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  r2_key           TEXT NOT NULL,
  hd1_version      INTEGER NOT NULL
);
CREATE INDEX idx_vaults_owner ON vaults(owner_account_id);
CREATE TABLE vault_envelopes (
  vault_id                 TEXT NOT NULL REFERENCES vaults(vault_id),
  principal_account_id     TEXT NOT NULL REFERENCES accounts(id),
  wrapped_dek              BLOB NOT NULL,
  ephemeral_public_key_jwk TEXT NOT NULL,
  created_by               TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  PRIMARY KEY (vault_id, principal_account_id)
);
CREATE INDEX idx_envelopes_principal ON vault_envelopes(principal_account_id);
CREATE TABLE provider_links (
  id                  TEXT PRIMARY KEY,
  patient_account_id  TEXT NOT NULL REFERENCES accounts(id),
  provider_account_id TEXT NOT NULL REFERENCES accounts(id),
  role                TEXT NOT NULL,
  status              TEXT NOT NULL,
  consent_ref         TEXT,
  granted_by          TEXT NOT NULL,
  granted_at          TEXT NOT NULL
);
CREATE INDEX idx_links_provider ON provider_links(provider_account_id);
CREATE INDEX idx_links_patient ON provider_links(patient_account_id);
CREATE TABLE crm_events (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  event      TEXT NOT NULL,
  stage_from TEXT,
  stage_to   TEXT,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  synced_at  TEXT
);
CREATE INDEX idx_crm_account ON crm_events(account_id);

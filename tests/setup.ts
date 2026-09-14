// W44 cutover — the migrated pablo/liz served blobs are HD1 v2, opened via the committed
// org-recovery sidecar (records/public/data-{id}.dek.enc) wrapped to the org operational key.
// vault-integrity.test.ts → verifyVaults() therefore needs ORG_KEY_PASSPHRASE. It is NOT
// committed in this repo — it lives in the plover-context credentials repo (health-dash.env);
// load-creds pulls it into process.env so the suite can open v2 blobs (override the dir with
// PLOVER_CREDENTIALS_DIR). An already-exported ORG_KEY_PASSPHRASE still wins.
import "../scripts/load-creds";

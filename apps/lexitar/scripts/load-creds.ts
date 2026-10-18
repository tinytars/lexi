// Load LexiTar's operational passphrases (ORG_KEY_PASSPHRASE, PASSPHRASE, …), its Google OAuth
// client and the Cloudflare API credentials from the credential stores — the canonical source;
// they are NOT committed in this repo. Import this for its side effect wherever a script/test
// needs those vars. Non-fatal by design: if a file is absent it leaves process.env untouched so
// the caller fails with its own clear error (and an already-set env var always wins). Point
// LEXI_CREDENTIALS_DIR at LexiTar's store, PLOVER_CREDENTIALS_DIR at the estate's.
//
// Each file is resolved independently, because the two stores hold different files rather than two
// copies of the same ones — gcp-oauth.env and health-dash.env are LexiTar's, cloudflare.env and
// anthropic.env are the estate's — so there is no single directory that is right for the whole
// list. creds-dir.ts explains the split; this file only walks it.
//
// gcp-oauth.env is in the list as of 2026-10-08 and had never been read here, which is the whole
// reason GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_KEK had to be exported by hand by
// anyone running a terminal script that needed them. It is the file those three actually live in.
//
// anthropic.env joins the list because the model key is what every inference script needs and the
// header above already assumes it is ambient — scripts/model-bench.ts resolves it through modelFor.
//
// W52: cloudflare.env joins the list because the snapshot/restore tooling talks to the R2 REST
// API directly (scripts/vault-sync.ts §REST) and needs the same CLOUDFLARE_* pair that
// scripts/wrangler.sh loads bash-side.
//
// The loader is deliberately generic — every key in those files is surfaced — so nothing here has to
// change when one is added. Which is why scripts/api-session.ts's LEXITAR_CLI_* vars are NOT among
// them: an account's password is also the KEK that opens its record, and rotate-pilot-credentials.ts
// stores a new one "nowhere — not in this repo, not in the credentials repo". That CLI asks for it on
// the terminal instead.
//
// LEXITAR_SUPPORT_* is loaded, and that is not a softening of the same rule: a support principal owns no
// record, so its password is a KEK for nothing — it lets the CLI present itself and reaches a record
// only while a patient's grant is live (VAULT.md §4a).
import { existsSync, readFileSync } from "node:fs";
import { credentialPath } from "./creds-dir";

for (const file of ["health-dash.env", "gcp-oauth.env", "cloudflare.env", "anthropic.env"]) {
  const path = credentialPath(file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

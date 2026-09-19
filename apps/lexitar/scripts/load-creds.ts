// Load health-dash operational passphrases (ORG_KEY_PASSPHRASE, PASSPHRASE, …) and the
// Cloudflare API credentials from the operator's private credential store — the canonical source;
// they are NOT committed in this repo. Import this for its side effect wherever a script/test
// needs those vars. Non-fatal by design: if a file is absent it leaves process.env untouched so
// the caller fails with its own clear error (and an already-set env var always wins). Override
// the dir with PLOVER_CREDENTIALS_DIR.
//
// W52: cloudflare.env joins the list because the snapshot/restore tooling talks to the R2 REST
// API directly (scripts/vault-sync.ts §REST) and needs the same CLOUDFLARE_* pair that
// scripts/wrangler.sh loads bash-side.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.env.PLOVER_CREDENTIALS_DIR ?? join(homedir(), "PabloTech", "plover-keys");

for (const file of ["health-dash.env", "cloudflare.env"]) {
  const path = join(dir, file);
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

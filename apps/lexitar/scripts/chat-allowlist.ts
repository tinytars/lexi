// Prints the VAULT_TOKEN value for the /api/vault Pages secret: the comma-joined per-client
// bearer hashes. Derives each with the SAME deriveBearerToken (src/lib/crypto.ts) that
// scripts/vault-sync.ts's bearer is built from, so the deployed allowlist can never desync.
// Default ids = the per-client vault slices in records/public/ (data-<id>.enc). Override with
// `--ids <id>,<id>`.
//
// Named for CHAT_TOKEN, which it also produced until that secret was deleted (2026-08-26).
//
//   npm run allowlist
//   npm run allowlist -- --ids <id>,<id>

import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { deriveBearerToken } from "@tinytars/vault/crypto";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, "../records/public");

async function discoverIds(): Promise<string[]> {
  const files = await readdir(PUBLIC_DIR);
  return files
    // Excludes the org-recovery sidecars (data-{id}.dek.enc), which would otherwise mint a bearer
    // for the bogus id "{id}.dek" and pad the deployed allowlist with tokens no client can present.
    .filter((f) => !f.endsWith(".dek.enc"))
    .map((f) => /^data-(.+)\.enc$/.exec(f)?.[1])
    .filter((id): id is string => !!id)
    .sort();
}

async function main() {
  const flag = process.argv.indexOf("--ids");
  const ids =
    flag !== -1 && process.argv[flag + 1]
      ? process.argv[flag + 1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      : await discoverIds();

  if (ids.length === 0) {
    process.stderr.write("no per-client vaults found (public/data-<id>.enc) and no --ids given\n");
    process.exit(1);
  }

  const tokens = await Promise.all(ids.map((id) => deriveBearerToken(id)));
  process.stderr.write(`# VAULT_TOKEN allowlist for ${ids.length} client(s): ${ids.join(", ")}\n`);
  process.stdout.write(tokens.join(",") + "\n");
}

main();

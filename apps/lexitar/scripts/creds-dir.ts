// Where LexiTar's credentials sit, resolved in one place — and since 2026-10-08 that is two places,
// resolved per file rather than per process.
//
// It had been spelled out three times with the same default baked in — scripts/creds.sh:6,
// scripts/load-creds.ts and, as of the key-material remediation, scripts/org-key.ts. Three copies
// of a path is three chances for one of them to keep pointing at a directory the other two have
// moved on from, and the one that matters most is the org key: a resolver that silently falls back
// to a path inside this repository is how `records/org-key.json` came to be committed at all.
//
// The shell half (creds.sh) stays its own line because a bash script cannot import this, and that
// is the one duplicate deliberately left; CREDENTIALS.md is where the two are held to each other.
//
// WHY TWO STORES, AND WHY PER FILE. LexiTar's own credentials moved out of the estate's shared
// store into one scoped to this product, so that a compromise of either no longer reaches both.
// The two stores hold DIFFERENT files, not two copies of the same ones — this product's org key,
// Google client and account logs in the lexi store; the estate's account-wide Cloudflare token and
// the shared Anthropic key in the plover store — so "which directory" has no answer that is right
// for the whole process. Asking it once, at startup, is what would send a reader of cloudflare.env
// to a store that will never hold it. So each file is looked up in each store in order, and the
// first store that HAS it wins.
//
// A WRITE lands in the primary, which is why credentialsDir() still exists and still means one
// directory: a file being created does not exist in either store yet, so there is nothing to search
// for and the only sane answer is "the store this product owns".
//
// A cloner of the public repository sets ONE variable and gets one store, because the fallback is
// only ever consulted on a miss. This estate sets two. Neither arrangement is special-cased.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The variables, in resolution order, paired with the clone each one defaults to. */
const STORES: readonly { env: string; fallback: readonly string[] }[] = [
  { env: "LEXI_CREDENTIALS_DIR", fallback: ["PabloTech", "lexi-keys"] },
  { env: "PLOVER_CREDENTIALS_DIR", fallback: ["PabloTech", "plover-keys"] },
];

/** Every credential store, in resolution order, deduplicated. Never a path inside this repo. */
export function credentialStores(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { env, fallback } of STORES) {
    const dir = process.env[env] ?? join(homedir(), ...fallback);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

/**
 * The store a NEW artifact is written to — `$LEXI_CREDENTIALS_DIR`, or the standing lexi-keys
 * clone. Read paths go through credentialPath() instead, which searches every store.
 */
export function credentialsDir(): string {
  return credentialStores()[0];
}

/**
 * A named artifact: the first store that holds it, or the primary's path when no store does — so a
 * caller creating a file gets the right destination and a caller reading one gets a path it can
 * report. Use missingCredential() for that report; it names both variables, which a bare ENOENT
 * on one path cannot.
 */
export function credentialPath(file: string): string {
  for (const dir of credentialStores()) {
    const path = join(dir, file);
    if (existsSync(path)) return path;
  }
  return join(credentialsDir(), file);
}

/**
 * The message for a credential no store holds. It names the file, every directory actually
 * searched and both variables, because the failure a reader meets is "it is not where I expected" and
 * a stack trace carrying one resolved path cannot tell them which of the two to set.
 */
export function missingCredential(file: string): string {
  const searched = credentialStores()
    .map((d) => `  ${join(d, file)}`)
    .join("\n");
  return (
    `creds: no store holds ${file}. Searched:\n${searched}\n` +
    `Point LEXI_CREDENTIALS_DIR at LexiTar's credential store (tinytars/lexi-keys), or ` +
    `PLOVER_CREDENTIALS_DIR at the estate's (promontory-studio/plover-keys).`
  );
}

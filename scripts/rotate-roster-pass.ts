// Give records/roster.enc its own passphrase, separate from PASSPHRASE.
//
// PASSPHRASE has been doing two unrelated jobs: it is the migration-seeded provider login AND the
// roster blob's encryption pass. Its value is the public provider slug, which the credential docs
// class as non-secret — so while one string does both, no textual scan can tell a credential
// disclosure from a legitimate identifier mention, and a real login sat unnoticed inside the
// credential-free e2e project for exactly that reason. Splitting them is what makes the roster's
// secret collide with nothing.
//
// The roster is the one artifact mapping an opaque client id back to a patient's name, so a
// four-character passphrase on it is the exposure that matters, whatever the KDF cost.
//
//   npm run roster:rotate            # --check (default): report, write NOTHING
//   npm run roster:rotate -- --apply
//
// --apply writes the new value into the plover-context credentials file beside its siblings. It is
// never printed: a rotation that echoes the secret into a terminal, a log or a transcript has moved
// the exposure rather than closed it. Set the GitHub Actions secret from that file afterwards.

import "./load-creds";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { encryptVault, decryptVault } from "@tinytars/vault/crypto";
import { DATA_PATH, PRIVATE_DIR, rosterPassFromEnv } from "./vault-io";
import type { Roster } from "../src/lib/types";

const PLAIN = resolve(PRIVATE_DIR, "roster.json");
const credentialsFile = (): string =>
  join(process.env.PLOVER_CREDENTIALS_DIR ?? join(homedir(), ".claude", "infra", "cloud", "credentials"), "health-dash.env");

/** 32 chars over a 56-symbol unambiguous alphabet ≈ 185 bits — and collides with no identifier. */
export function generatePassphrase(length = 32): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= 256 - (256 % alphabet.length)) continue; // rejection-sample so the alphabet stays uniform
      out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Appended rather than rewritten: this file holds every other cloud secret and is not ours to reflow. */
export function withRosterPass(body: string, pass: string): string {
  const entry =
    `# The roster blob's own passphrase (2026-08-31). Split from PASSPHRASE, which is also the\n` +
    `# migration-seeded provider login and equals the public provider slug — one string doing both\n` +
    `# jobs made a credential indistinguishable from an identifier to any textual scan.\n` +
    `ROSTER_PASS=${pass}\n`;
  return body.endsWith("\n") ? `${body}\n${entry}` : `${body}\n\n${entry}`;
}

/**
 * Push the value from the credentials file to the Actions secret, over stdin so it never becomes an
 * argv entry (visible in `ps`) nor reaches a terminal. `local` and the ops action both need it, and
 * a rotation that updates only the workstation makes CI red instead of secure.
 */
async function pushSecret(): Promise<void> {
  const file = credentialsFile();
  const line = readFileSync(file, "utf8").split("\n").find((l) => /^\s*(?:export\s+)?ROSTER_PASS=/.test(l));
  if (!line) throw new Error(`no ROSTER_PASS in ${file} — run \`npm run roster:rotate -- --apply\` first`);
  let value = line.slice(line.indexOf("=") + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  const child = execFile("gh", ["secret", "set", "ROSTER_PASS", "--repo", "pablo-tech/plover-code"]);
  child.stdin!.end(value);
  await new Promise<void>((ok, fail) =>
    child.on("close", (code) => (code === 0 ? ok() : fail(new Error(`gh secret set exited ${code}`)))),
  );
  process.stdout.write("Actions secret ROSTER_PASS set from the credentials file (value not printed).\n");
}

async function main(): Promise<void> {
  if (process.argv.includes("--push-secret")) return pushSecret();
  const apply = process.argv.includes("--apply");
  const current = rosterPassFromEnv();
  if (!current) throw new Error("no current roster passphrase — source the plover-context health-dash.env");

  // Prove the blob opens before touching anything, and that it is what we think it is.
  const roster = await decryptVault<Roster>(new Uint8Array(readFileSync(DATA_PATH)), current);
  if (roster.kind !== "roster") throw new Error("records/roster.enc did not open as a roster");
  const plain = JSON.parse(readFileSync(PLAIN, "utf8")) as Roster;
  if (Object.keys(plain.clients).length !== Object.keys(roster.clients).length) {
    throw new Error("roster.json and roster.enc disagree — run `npm run vault:build` first");
  }

  const separate = !!process.env.ROSTER_PASS && process.env.ROSTER_PASS !== process.env.PASSPHRASE;
  if (!apply) {
    process.stdout.write(
      `records/roster.enc — ${Object.keys(roster.clients).length} client(s), opens under ` +
        `${process.env.ROSTER_PASS ? "ROSTER_PASS" : "PASSPHRASE"} (${current.length} chars)\n` +
        (separate
          ? "already rotated: ROSTER_PASS is set and differs from PASSPHRASE\n"
          : "NOT rotated: the roster shares PASSPHRASE, which is the public provider slug.\n" +
            "  rotate: npm run roster:rotate -- --apply\n"),
    );
    process.exit(separate ? 0 : 1);
  }

  if (separate) throw new Error("ROSTER_PASS is already set and differs from PASSPHRASE — nothing to rotate");

  const backup = `${DATA_PATH}.before-rotation`;
  copyFileSync(DATA_PATH, backup);

  const next = generatePassphrase();
  // Encrypt from the plaintext source of truth, not from what was just decrypted.
  writeFileSync(DATA_PATH, await encryptVault(plain, next));

  // Prove what LANDED, not what was sent: the new pass opens it and the old one no longer does.
  const reread = await decryptVault<Roster>(new Uint8Array(readFileSync(DATA_PATH)), next);
  if (JSON.stringify(reread) !== JSON.stringify(plain)) {
    copyFileSync(backup, DATA_PATH);
    throw new Error("round-trip mismatch — blob restored from backup, nothing changed");
  }
  let oldStillOpens = true;
  try {
    await decryptVault<Roster>(new Uint8Array(readFileSync(DATA_PATH)), current);
  } catch {
    oldStillOpens = false;
  }
  if (oldStillOpens) {
    copyFileSync(backup, DATA_PATH);
    throw new Error("the old passphrase still opens the blob — restored, nothing changed");
  }

  const file = credentialsFile();
  writeFileSync(file, withRosterPass(readFileSync(file, "utf8"), next));

  process.stdout.write(
    `rotated records/roster.enc — ${Object.keys(plain.clients).length} client(s)\n` +
      `  old passphrase rejected: true\n` +
      `  ROSTER_PASS written to ${file} (value not printed)\n` +
      `  backup: ${backup} — delete it once CI is green\n\n` +
      `Next: set the Actions secret from that file, then commit the re-encrypted blob.\n` +
      `  npm run roster:rotate -- --push-secret\n`,
  );
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}

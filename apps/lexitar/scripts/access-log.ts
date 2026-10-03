// W55 Phase 4 — the org key lives only in the CLI (no Pages Function ever holds it), so every
// org-key decrypt is logged from here, into the same `phi_access_events` table the app-side
// support/self-service audit trail writes to (functions/_lib/identity.ts insertAccessEvent).
//
// recordOrgKeyUse() buffers in-process (deduped per clientId+purpose); flushOrgKeyUses() writes
// one lookup + one batched INSERT over `wrangler.sh d1 execute --remote` (the org-d1.ts pattern).
// Every use reaches scripts/org-unwrap.ts, which records it before it yields a key, so a caller no
// longer has to remember; a caller still ends its main entry path with flushOrgKeyUses() on both the
// success and the failure exit. A flush failure throws: a silent audit trail is exactly the failure
// mode this file exists to close.
//
// NOTHING IS DROPPED ANY MORE — the two ways a use used to vanish are both closed by the spool below.
// `ORG_ACCESS_LOG=off` (offline work) spools instead of discarding, a flush that cannot reach D1
// spools instead of losing what it had already taken from the buffer, and a script that exits without
// flushing at all spools from a `process.on("exit")` handler. The next online flush drains the file.
// The handler spools rather than inserting because a network round trip at process exit is the least
// reliable moment to take one, and spooling is one synchronous write that cannot mask the real exit.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { wranglerTarget } from "./target";

const here = dirname(fileURLToPath(import.meta.url));
const WRANGLER = resolve(here, "wrangler.sh");
// W53 P4: derived from the worktree's wrangler.jsonc — see scripts/target.ts.
const DB = wranglerTarget().database;
const ORG_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
/** The audited id is a vault's `r2_key` stem; org-unwrap.ts checks it before any crypto happens. */
export const CLIENT_ID_RE = /^[a-z0-9-]+$/;

interface OrgKeyUse {
  clientId: string;
  purpose: string;
}

/** A use on its way to, or back from, the spool: which run made it and when, not the current run's. */
interface SpooledUse extends OrgKeyUse {
  script: string;
  at: string;
}

const buffered = new Map<string, OrgKeyUse>();
let exitHooked = false;

export function recordOrgKeyUse(use: OrgKeyUse): void {
  buffered.set(`${use.clientId}:${use.purpose}`, use);
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", spoolUnflushedSync);
}

/** The `process.on("exit")` action: what was never flushed goes to the spool, never to the network. */
export function spoolUnflushedSync(): void {
  spool(takeBuffered());
}

/** Ids only — no PHI, no key material — so the file is an audit backlog, not a copy of a record. */
function spoolPath(): string {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "lexitar", "access-spool.ndjson");
}

function spool(entries: SpooledUse[]): void {
  if (entries.length === 0) return;
  const path = spoolPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
}

function drainSpool(): SpooledUse[] {
  const path = spoolPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  // Removed before the INSERT is attempted, and rewritten by the caller if that attempt throws, so a
  // successful flush leaves no replay behind. An INSERT that lands and then fails on the way back is
  // logged twice; duplicate audit rows are the right side of that trade against losing one.
  unlinkSync(path);
  return lines.map((l) => JSON.parse(l) as SpooledUse);
}

function takeBuffered(): SpooledUse[] {
  const script = basename(process.argv[1] ?? "unknown");
  const at = new Date().toISOString();
  const entries = [...buffered.values()].map((u) => ({ ...u, script, at }));
  buffered.clear();
  return entries;
}

function runD1(sql: string): { results: Record<string, unknown>[] }[] {
  const out = execFileSync("bash", [WRANGLER, "d1", "execute", DB, "--remote", "--json", "--command", sql], {
    encoding: "utf8",
  });
  return JSON.parse(out) as { results: Record<string, unknown>[] }[];
}

function insert(entries: SpooledUse[]): void {
  const ids = [...new Set(entries.map((u) => u.clientId))];
  const inList = ids.map((id) => `'data-${id}.enc'`).join(", ");
  const lookup = runD1(`SELECT vault_id, owner_account_id, r2_key FROM vaults WHERE r2_key IN (${inList});`);
  const byId = new Map(
    (lookup[0]?.results ?? []).map((r) => [String(r.r2_key).replace(/^data-/, "").replace(/\.enc$/, ""), r] as const),
  );

  const values: string[] = [];
  for (const { clientId, purpose, script, at } of entries) {
    const row = byId.get(clientId);
    if (!row) {
      process.stdout.write(`access-log: no vault row for "${clientId}" — skipping (local-only fixture?)\n`);
      continue;
    }
    const meta = JSON.stringify({ script, purpose }).replace(/'/g, "''");
    values.push(
      `('${randomUUID()}', '${ORG_ACCOUNT_ID}', '${row.owner_account_id}', '${row.vault_id}', 'org_key_decrypt', NULL, '${meta}', '${at}')`,
    );
  }
  if (values.length === 0) return;

  runD1(
    `INSERT INTO phi_access_events (id, actor_account_id, subject_account_id, vault_id, action, consent_ref, meta, created_at) VALUES ${values.join(", ")};`,
  );
}

/** The whole flush, synchronous throughout — which is what lets the exit handler share its parts. */
export function flushOrgKeyUsesSync(): void {
  const taken = takeBuffered();
  // Not spooled: an id no INSERT can ever accept would fail every future flush from the file instead
  // of this one. org-unwrap.ts rejects the same ids before any crypto, so nothing reaches here by key.
  for (const { clientId } of taken) {
    if (!CLIENT_ID_RE.test(clientId)) throw new Error(`access-log: refusing to log non-slug clientId "${clientId}"`);
  }
  if (process.env.ORG_ACCESS_LOG === "off") return spool(taken);

  const entries = [...drainSpool(), ...taken];
  if (entries.length === 0) return;
  try {
    insert(entries);
  } catch (e) {
    spool(entries);
    throw e;
  }
}

export async function flushOrgKeyUses(): Promise<void> {
  flushOrgKeyUsesSync();
}

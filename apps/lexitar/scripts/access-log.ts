// W55 Phase 4 — the org key lives only in the CLI (no Pages Function ever holds it), so every
// org-key decrypt is logged from here, into the same `phi_access_events` table the app-side
// support/self-service audit trail writes to (functions/_lib/identity.ts insertAccessEvent).
//
// recordOrgKeyUse() buffers in-process (deduped per clientId+purpose); flushOrgKeyUses() writes
// one lookup + one batched INSERT over `wrangler.sh d1 execute --remote` (the org-d1.ts pattern).
// Call flushOrgKeyUses() once at the end of every script's main entry path, on both the success
// and failure exits — a decrypt that happened must be logged even if the run then fails. A flush
// failure throws: a silent audit trail is exactly the failure mode this file exists to close.
//
// Escape hatch for offline work: ORG_ACCESS_LOG=off skips the flush (buffered uses are dropped).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { wranglerTarget } from "./target";

const here = dirname(fileURLToPath(import.meta.url));
const WRANGLER = resolve(here, "wrangler.sh");
// W53 P4: derived from the worktree's wrangler.jsonc — see scripts/target.ts.
const DB = wranglerTarget().database;
const ORG_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_ID_RE = /^[a-z0-9-]+$/;

interface OrgKeyUse {
  clientId: string;
  purpose: string;
}

const buffered = new Map<string, OrgKeyUse>();

export function recordOrgKeyUse(use: OrgKeyUse): void {
  buffered.set(`${use.clientId}:${use.purpose}`, use);
}

function runD1(sql: string): { results: Record<string, unknown>[] }[] {
  const out = execFileSync("bash", [WRANGLER, "d1", "execute", DB, "--remote", "--json", "--command", sql], {
    encoding: "utf8",
  });
  return JSON.parse(out) as { results: Record<string, unknown>[] }[];
}

export async function flushOrgKeyUses(): Promise<void> {
  const uses = [...buffered.values()];
  buffered.clear();
  if (uses.length === 0 || process.env.ORG_ACCESS_LOG === "off") return;

  const ids = [...new Set(uses.map((u) => u.clientId))];
  for (const id of ids) {
    if (!CLIENT_ID_RE.test(id)) throw new Error(`access-log: refusing to log non-slug clientId "${id}"`);
  }

  const inList = ids.map((id) => `'data-${id}.enc'`).join(", ");
  const lookup = runD1(`SELECT vault_id, owner_account_id, r2_key FROM vaults WHERE r2_key IN (${inList});`);
  const byId = new Map(
    (lookup[0]?.results ?? []).map((r) => [String(r.r2_key).replace(/^data-/, "").replace(/\.enc$/, ""), r] as const),
  );

  const script = basename(process.argv[1] ?? "unknown");
  const now = new Date().toISOString();
  const values: string[] = [];
  for (const { clientId, purpose } of uses) {
    const row = byId.get(clientId);
    if (!row) {
      process.stdout.write(`access-log: no vault row for "${clientId}" — skipping (local-only fixture?)\n`);
      continue;
    }
    const meta = JSON.stringify({ script, purpose }).replace(/'/g, "''");
    values.push(
      `('${randomUUID()}', '${ORG_ACCOUNT_ID}', '${row.owner_account_id}', '${row.vault_id}', 'org_key_decrypt', NULL, '${meta}', '${now}')`,
    );
  }
  if (values.length === 0) return;

  runD1(
    `INSERT INTO phi_access_events (id, actor_account_id, subject_account_id, vault_id, action, consent_ref, meta, created_at) VALUES ${values.join(", ")};`,
  );
}

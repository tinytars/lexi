# BACKUP.md — snapshots, the restore drill, and the alarm

Beta users' vaults live **only** in R2. This is the backup.

The rule this file exists to enforce: **a backup that has never been restored is not a backup.**
The snapshot is only the input; [the drill](#the-drill) is the deliverable.

## Commands

| Command | What it does |
|---|---|
| `npm run vault:snapshot` | Snapshot the live store + D1 → `health-vault-backup`, verify it, prune to 30 |
| `npm run vault:snapshot -- --dry-run` | List and classify only; writes nothing |
| `npm run vault:restore` | Restore the newest snapshot to a scratch prefix and open every vault |
| `npm run vault:restore -- --keep-scratch` | …and leave the restored objects in R2 to inspect |
| `npm run vault:snapshot:check` | Is a fresh snapshot present? Non-zero if not (also run by `npm run doctor`) |
| `npm run vault:rotate` | Report which accounts still hold a seeded password (read-only) |

All of them need `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`; the restore drill also needs
`ORG_KEY_PASSPHRASE`. All three are local credential files loaded by `scripts/load-creds.ts`
(not committed in this repo).

## What a snapshot contains

`{bucket}/stores/{store}/snapshots/{id}/`, where `{id}` is a UTC timestamp (`2026-08-09T03-15-00Z`)
and `{bucket}` is this worktree's R2 bucket plus `-backup` (dev → `health-vault-backup`, prod →
`health-vault-prod-backup`):

```
d1/health-identity-dev.sql    full D1 export — the authoritative restore artifact
d1/health-identity-dev.json   the same rows as JSON (BLOBs hex-encoded) — what the drill reads
r2/{store}/data-{id}.enc      vault ciphertext, object for object
r2/{store}/chat-{id}.enc      chat history
r2/{store}/raw/{id}/{file}    original uploads — PLAINTEXT PHI
logs.ndjson                   the audit trail, one line per event object
manifest.json                 every key, size and sha256 + the D1 row counts
```

Plus `stores/{store}/manifests/{id}.json` (a copy, so listing snapshots is cheap) and
`stores/{store}/latest.json` (the pointer the freshness alarm reads).

**Everything is keyed by the source store, and that is load-bearing.** Snapshot ids are
timestamps, so before this, two stores backed up into one bucket collided on the same manifest key —
and retention, which listed `manifests/` globally and deleted everything past `--keep`, would have
deleted prod's first-ever backup on dev's next nightly. `latest.json` was global too, so the
freshness alarm reported green for a store that had never been snapshotted. `prune`, `listSnapshotIds`
and `checkFreshness` are all store-scoped now, and `tests/unit/vault-snapshot-retention.test.ts`
puts two stores in one bucket and asserts neither touches the other.

This layout change **restarts the retention lineage**: objects still sitting at the old unprefixed
`snapshots/`, `manifests/` and `latest.json` are no longer read or pruned by this code. They are
orphaned, not deleted — delete them by hand once a new snapshot exists. Until that first new run,
`npm run vault:snapshot:check` will correctly report that no snapshot has ever completed for this
store.

Two deliberate choices:

- **D1 is not optional.** `vault_envelopes.wrapped_dek` holds the wrapped DEK for every vault; an
  R2-only backup restores ciphertext nobody can open. It is also snapshotted **first**, so a
  wrangler failure costs seconds rather than the seven minutes the R2 copy takes.
- **The audit trail is bundled**, not copied object-for-object. It is ~1200 tiny objects and growing;
  individually they would dominate the API rate limit nightly and make pruning one snapshot ~1200
  deletes. Each entry's bytes are sha256-checked before and after bundling.

An unrecognised key shape under the store prefix is a **hard failure**, not a skip
(`classifyKey()` in `scripts/vault-sync.ts`) — a new key class added to `storeKey()` elsewhere
cannot silently fall out of the backup.

## The drill

```
npm run vault:restore
```

1. Reads the snapshot manifest and restores every non-log object into a **scratch** store prefix
   (`restore-{id}`) in the live bucket — never over `dev`/`prod`, which is refused outright.
2. Checks each restored object's sha256 against the manifest.
3. Reads `vaults` + `vault_envelopes` **from the snapshot's D1 dump, not from live D1**, finds the
   org principal by matching `records/org-key.json` against the restored `public_keys`, and opens
   every registered vault: HD1 magic → unwrap DEK → decrypt → parse.
4. Deletes the scratch prefix (pass `--keep-scratch` to keep it).

**Pass condition: every vault the org holds an envelope for opens.** A vault the org has *no* envelope
for is verified to the byte (digest, HD1 magic, correct key) and reported as `bytes-only` — that is the
intended key custody, not a backup defect: only the account holder's client can decrypt it, and only
they can ever grant anyone else that ability (see `AUTH.md` for the org recovery envelope model).
Vault blobs with no `vaults` row at all are listed separately — nothing registers them.

Because it restores to a scratch prefix, this is safe to run any day, which is the point: an
emergency-only procedure is one nobody has tested.

## Retention and the alarm

Retention is **30 snapshots**, pruned oldest-first at the end of each run. A snapshot directory with
no manifest is an aborted run; it is swept after a 6-hour grace window so a partial run can't
accumulate forever.

The schedule is **`.github/workflows/snapshot.yml`**, daily at 03:15 UTC, one job per store
(`prod` and `dev`). It runs `vault:snapshot` and then, separately, `vault:snapshot:check` — the
second is what catches a run that exits 0 having written nothing.

Dispatch one by hand from the Actions tab, choosing the store and optionally the retention window.

```bash
gh workflow run snapshot.yml -f store=prod
```

**It used to be a macOS LaunchAgent on one laptop.** That was always the known weakness
— no snapshot happens while a machine is off — and retiring the self-hosted CI
runner from that same Mac made it worse, so the laptop stopped being part of any other pipeline and nothing
noticed when it was off, while remaining the only host of the only scheduled backup this project
has. The LaunchAgent and its plist are gone; the schedule now runs where nothing depends on a lid
being open.

`scripts/snapshot-cron.sh` is **kept and still works** — `bash scripts/snapshot-cron.sh` is the
by-hand and recovery path, with its own `scripts/lock.sh` lock and its own macOS notification.
Deleting it would remove the only path that does not depend on GitHub being reachable.

A silent cron is indistinguishable from no backup, so failure stays loud. On the hosted schedule the
alarm is the **job going red** — a runner cannot post a macOS notification, and that is the same
posture `tip-watch.yml` takes: absence is the failure mode. Do not soften it with
`continue-on-error`. The hand-run script keeps its notification and its dated log under `.snapshot/`
(gitignored).

Two runs of the snapshot never overlap. On CI that is `concurrency: snapshot-{store}` with
`cancel-in-progress: false`; by hand it is `scripts/lock.sh`'s per-store lock. Both exist for the
same reason: the retention prune lists snapshots and then deletes what it listed, so a second run
finishing inside that window is deleted by a decision made before it existed. A blocked hand-run
logs and exits 0 rather than paging. `npm run d1:migrate:remote` takes the same kind of lock, keyed
by database name.

Independently of the job, `npm run vault:snapshot:check` fails when the newest snapshot is older
than 36 hours — and `npm run doctor` runs it, so a dead schedule surfaces in the ordinary dev loop
rather than the next incident. That second, independent path is unchanged by the move and is the
reason a missed red job is not a silent failure.

**This is flagged as a decision rather than fixed.** It changed character when the self-hosted CI
runner was retired from this same Mac: the laptop is no longer part of any other pipeline, so
nothing else in the project notices when it is off, and the only scheduled backup this project has
now runs on a machine whose lid closing is a normal event. The alarm still fires — into the same
laptop.

## Notes

- **R2 has no object versioning** on this account — the feature does not exist for R2, so a second
  layer of protection is not available. The nearest equivalent is a bucket **lock** rule
  (`wrangler r2 bucket lock`), which makes objects undeletable for a retention period. It is not
  enabled: it would also block the 30-day prune, and it is hard to undo. Worth revisiting for prod
  with a lock window shorter than the retention window.
- A snapshot takes ~7.5 minutes, almost all of it fetching audit-log objects one at a time. The
  Cloudflare API rate limit (~1200 requests / 5 min, account-wide) is why `scripts/vault-sync.ts`
  throttles to 3 requests/second; `CF_API_RPS` overrides it for a one-off catch-up.
- Snapshots copy bodies byte for byte, so once a store is sealed they hold no plaintext PHI — the
  `raw/` originals arrive as ciphertext under keys that live only inside the vault blobs
  (`VAULT.md` §2a). They still hold the **wrapped DEKs**, so the backup bucket remains exactly as
  sensitive as the live one: whoever can open a vault there can open its originals too.

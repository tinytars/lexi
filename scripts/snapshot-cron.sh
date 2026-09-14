#!/usr/bin/env bash
# W52 Phase 4 — the scheduled entry point. Runs the snapshot, then independently asks whether a
# fresh snapshot actually exists, and raises a visible alarm if either step fails.
#
# The whole point of this milestone is that a backup which quietly stops is worse than no backup,
# so failure here is loud three ways: a macOS notification, a non-zero exit (which launchd records),
# and a dated log kept under .snapshot/. `npm run doctor` independently re-checks freshness, so a
# missed notification still surfaces in the ordinary dev loop.
#
# W77 — this is no longer the SCHEDULED path. The daily backup is .github/workflows/snapshot.yml,
# which runs where no lid can close on it; the LaunchAgent and its plist are gone. This script is
# kept deliberately as the by-hand and recovery path — it is the only one that does not depend on
# GitHub being reachable, and it keeps the macOS notification a runner cannot send.
#
# Run it any time:  bash scripts/snapshot-cron.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# launchd gives a job almost no environment; mirror what scripts/wrangler.sh sets up.
[ -d "$HOME/homebrew/bin" ] && export PATH="$HOME/homebrew/bin:$PATH"
# W75 — set it only when the file exists, exactly as scripts/wrangler.sh does. Node >=18 throws at
# startup on an unreadable NODE_EXTRA_CA_CERTS, so the old unconditional export made this job die
# before it began anywhere the macOS bundle path is absent.
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -r /etc/ssl/cert.pem ]; then
  export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem
fi

KEEP="${SNAPSHOT_KEEP:-30}"
LOG_DIR=".snapshot"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date -u +%Y-%m-%dT%H-%M-%SZ).log"

alarm() {
  printf '\033[31mBACKUP ALARM: %s\033[0m\n' "$1" | tee -a "$LOG" >&2
  osascript -e "display notification \"$1\" with title \"health-dash backup FAILED\" sound name \"Basso\"" >/dev/null 2>&1
}

{
  echo "=== health-dash snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ) (keep=$KEEP)"
} >> "$LOG"

# The run ends in a retention prune that lists snapshots and then deletes what it listed; two
# overlapping runs let the second one be deleted by a decision the first made before it existed.
# Keyed by the store this worktree deploys to, so a dev run and a prod run do not block each other.
. "$SCRIPT_DIR/lock.sh"
STORE="$(sed -E 's@^[[:space:]]*//.*$@@' wrangler.jsonc | jq -r '.vars.STORE_PREFIX // empty' 2>/dev/null || true)"
STORE="${STORE:-dev}"

# Not `if ! with_lock …`: under `!` the then-branch sees the negated status, so the 75 that means
# "someone else is running" would arrive here as 1 and page someone.
with_lock "snapshot-$STORE" npm run --silent vault:snapshot -- --keep "$KEEP" >> "$LOG" 2>&1
status=$?
if [ "$status" -eq 75 ]; then
  echo "another snapshot run holds the lock; skipping this window" >> "$LOG"
  exit 0
fi
if [ "$status" -ne 0 ]; then
  alarm "snapshot run failed — see $(pwd)/$LOG"
  exit 1
fi

# Asked separately from the run above on purpose: this is the check that would catch a job that
# exited 0 without writing anything.
if ! npm run --silent vault:snapshot:check >> "$LOG" 2>&1; then
  alarm "snapshot completed but no fresh backup is present — see $(pwd)/$LOG"
  exit 1
fi

# Same retention window for the run logs as for the snapshots themselves.
ls -1t "$LOG_DIR"/*.log 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "=== ok $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"

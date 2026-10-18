#!/usr/bin/env bash
# W53 — apply D1 migrations to the database THIS BRANCH's wrangler.jsonc declares.
#
# The database name was previously hardcoded to health-identity-dev in package.json, which made two
# things impossible: running the suite from the `main` worktree at all, and migrating PROD ever. That
# second one matters — `wrangler.jsonc` is deliberately divergent per branch (dev → health-identity-dev,
# main → health-identity-prod), so "migrate the database" only has a correct answer relative to a
# branch. Deriving it here means you cannot accidentally point a prod migration at dev, or vice versa:
# the worktree you run in picks the target.
#
#   npm run d1:migrate:local    # this branch's DB, local sqlite under .wrangler/state
#   npm run d1:migrate:remote   # this branch's REAL database (dev from dev, prod from main)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

MODE="${1:-}"
case "$MODE" in
  --local|--remote) ;;
  *) echo "usage: d1-migrate.sh --local|--remote" >&2; exit 2 ;;
esac

# Strip whole-line // comments so jq can read the JSONC.
D1_NAME="$(sed -E 's@^[[:space:]]*//.*$@@' wrangler.jsonc | jq -r '.d1_databases[0].database_name')"
[ -n "$D1_NAME" ] && [ "$D1_NAME" != "null" ] \
  || { echo "d1-migrate: cannot read d1_databases[0].database_name from wrangler.jsonc" >&2; exit 1; }

if [ "$MODE" = "--remote" ]; then
  # A remote migration is irreversible and, on main, runs against live PHI-adjacent identity rows.
  # Name the target before doing it rather than after.
  echo "d1-migrate: applying migrations to REMOTE database '$D1_NAME' (branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?'))"
  # W75 — serialize on the database name. Two applies racing wrangler's migration ledger against one
  # D1 is the failure this guards; keying on the name (not the worktree) is what makes two agents in
  # two worktrees pointed at the same database collide, which is the case that happens.
  . "$SCRIPT_DIR/lock.sh"
  with_lock "d1-$D1_NAME" bash "$SCRIPT_DIR/wrangler.sh" d1 migrations apply "$D1_NAME" --remote
  exit $?
fi

echo "d1-migrate: applying migrations to LOCAL '$D1_NAME'"
exec bash "$SCRIPT_DIR/wrangler.sh" d1 migrations apply "$D1_NAME" --local --persist-to .wrangler/state

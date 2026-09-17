#!/usr/bin/env bash
# W44 e2e harness: serve the built SPA + real Pages Functions via `wrangler pages dev`, backed by a
# LOCAL D1 seeded with the migrated pilot accounts (0001 schema + 0002 seed). Replaces the old
# `vite dev` webServer — account login needs the Functions + D1 that vite can't serve. Local R2
# self-seeds each vault blob from the built dist assets on first GET (functions/api/vault/[id].ts).
set -euo pipefail
cd "$(dirname "$0")/.."
# Guarded, like scripts/wrangler.sh:12, check-env.sh:46 and snapshot-cron.sh:17 — this script was the
# only one that hardcoded the prefix unconditionally, which makes it the one that cannot run on Linux.
[ -d "$HOME/homebrew/bin" ] && export PATH="$HOME/homebrew/bin:$PATH"
STATE=".wrangler/state"

# W74 — refuse to start when a server we do not own is already on the port, BEFORE destroying state.
#
# The `rm -rf` below is the destructive step, and nothing used to stand between it and a second run:
# run B wiped run A's local D1 out from under it, then failed to bind the port anyway. A lost the
# database it was mid-suite against and reported it as unrelated test failures. Checking first turns
# that into a refusal with a path in it.
#
# Covers the same-checkout race too — e2e-clean.sh, which `npm run test:e2e` runs first, has already reaped
# anything of ours by this point, so a holder that survives it is by definition someone else's.
#
# Before the build, not next to the `rm -rf`: a refusal that costs 30s of vite first is one a person
# learns to run past.
PORT="${E2E_PORT:-8788}"
ROOT="$PWD"
. scripts/port-lib.sh
BUSY="$(foreign_holders)"
[ -z "$BUSY" ] || {
  echo "e2e-serve: port $PORT is already served by a process this checkout does not own:" >&2
  echo "$BUSY" | sed 's/^/  /' >&2
  echo "e2e-serve: refusing to start — stop that server, or run from the checkout that owns it." >&2
  echo "e2e-serve: (starting anyway would erase $STATE, which that run is using.)" >&2
  exit 1
}


# Local, non-secret test env for the Functions (only written if the dev hasn't set real secrets).
# SESSION_SECRET can be any stable string — e2e logs in through the real server, which signs the
# cookie itself. WEBAUTHN_ORIGIN must match the port below (see .dev.vars.example).
if [ ! -f .dev.vars ]; then
  cat > .dev.vars <<'VARS'
SESSION_SECRET=e2e-test-session-secret
WEBAUTHN_RP_ID=localhost
WEBAUTHN_RP_NAME=LexiTar
WEBAUTHN_ORIGIN=http://localhost:8788
PROVIDER_TOKEN=e2e-provider-token
VAULT_TOKEN=e2e-vault-token
GOOGLE_CLIENT_ID=e2e-google-client
GOOGLE_CLIENT_SECRET=e2e-google-secret
GOOGLE_KEK=ZTJlLXRlc3QtZ29vZ2xlLWtlay0zMi1ieXRlcy1sb25nISE=
VARS
fi

# W69 — the build is the largest transient RSS in this script (vite + esbuild + rollup), and running
# it INSIDE the Playwright webServer command overlapped its peak with Chromium launching, on a machine
# already near its swap limit. That overlap is what tipped workerd into a jetsam kill. CI already ran
# `npm run build` as its own step immediately before, so there it is pure duplicate work (~30s) as
# well as duplicate memory; it sets E2E_SKIP_BUILD=1 and dist/ is already on disk.
if [ "${E2E_SKIP_BUILD:-}" = 1 ]; then
  [ -d dist ] || { echo "e2e-serve: E2E_SKIP_BUILD=1 but dist/ is missing — run 'npm run build' first" >&2; exit 1; }
  echo "e2e-serve: reusing existing dist/ (E2E_SKIP_BUILD=1)"
else
  npm run build
fi
# W53: read the D1 name from wrangler.jsonc rather than hardcoding it. This file is DELIBERATELY
# divergent per branch (dev binds health-identity-dev, main binds health-identity-prod), so a
# hardcoded dev name made the whole e2e suite unrunnable from the `main` worktree — which is exactly
# where .githooks/pre-push runs it during a promotion. It failed as "TESTS FAILED" on a wrangler
# error ("Couldn't find a D1 DB with the name or binding 'health-identity-dev'"), i.e. a config
# mismatch wearing the costume of a broken test. Everything here is --local: no remote DB is touched.
D1_NAME="$(sed -E 's@^[[:space:]]*//.*$@@' wrangler.jsonc | jq -r '.d1_databases[0].database_name')"
[ -n "$D1_NAME" ] && [ "$D1_NAME" != "null" ] || { echo "e2e-serve: cannot read d1_databases[0].database_name from wrangler.jsonc" >&2; exit 1; }
echo "e2e-serve: local D1 = $D1_NAME (from wrangler.jsonc)"
# Start from a clean local D1/R2 each boot so e2e is deterministic — no rows accumulate across runs
# (the self-contained support flow writes phi_access_events/vault_envelopes that would otherwise pile
# up). Migrations below re-seed the pilots (0002); R2 self-seeds vault blobs from dist on first GET.
rm -rf "$STATE"
# Seed the local identity DB (idempotent — wrangler's d1_migrations table skips already-applied
# files). Same --persist-to as pages dev so both read one sqlite. wrangler is a local dep → npx.
npx wrangler d1 migrations apply "$D1_NAME" --local --persist-to "$STATE"
# W44 P4b — seed a LOGINABLE support agent (LOCAL only, idempotent) so the support-access e2e can drive
# the full flow itself (support requests a fresh patient → patient approves). Fixed id + RESET so a
# persisted .wrangler/state re-seeds cleanly across restarts.
RESET=1 EMAIL=support@local.invalid PASSWORD=support ACCOUNT_ID=e2e5upp0-0000-4000-8000-000000000001 \
  npx tsx scripts/provision-support-account.ts > "$STATE/support-seed.sql"
npx wrangler d1 execute "$D1_NAME" --local --persist-to "$STATE" --file "$STATE/support-seed.sql"

# W69 — one fully synthetic patient per Playwright worker (LOCAL only, idempotent).
#
# The suite is pinned to `workers: 1` (see playwright.config.ts) because specs still share backend
# state through the E2E_CLINICIAN/E2E_SUPPORT accounts, so two workers racing on the same patient would
# lose each other's writes. Giving each worker its own patient removes the shared-*patient* state
# rather than mocking the save path. Per WORKER, not per spec file: Playwright never runs two files
# concurrently inside a worker, so four provisions buy what thirty-seven would.
#
# Needs no credential of any kind — the password is the slug and the DEK is wrapped to public keys
# only (see scripts/provision-e2e-patient.ts). That is what will let e2e leave this machine.
#
# AFTER the build: vite empties dist/, and the blob is written there for the Function's ASSETS
# self-seed (functions/api/vault/[id].ts:131) to pick up on the first GET.
# ONE invocation: the synthetic clinician's private key exists only inside the process that mints it,
# so the patients whose DEKs are wrapped to it must be built in the same run.
#
# Named failures: `set -e` would otherwise abort the server here and surface as a webServer timeout —
# all 216 specs failing with nothing pointing at the seeding step that actually broke.
#
# The default below must match SYNTHETIC_WORKER_COUNT in tests/fixtures/synthetic-patient.ts — a
# shell script can't import that constant, so this is the one place the two are kept in sync by hand.
E2E_WORKERS="${E2E_WORKERS:-4}"
E2E_WORKERS="$E2E_WORKERS" OUT=dist npx tsx scripts/provision-e2e-patient.ts > "$STATE/e2e-world.sql" \
  || { echo "e2e-serve: FAILED to build the synthetic patients (provision-e2e-patient.ts)" >&2; exit 1; }
npx wrangler d1 execute "$D1_NAME" --local --persist-to "$STATE" --file "$STATE/e2e-world.sql" \
  || { echo "e2e-serve: FAILED to seed synthetic patients into D1 — see $STATE/e2e-world.sql" >&2; exit 1; }
echo "e2e-serve: provisioned $E2E_WORKERS synthetic patient(s) + an e2e-only clinician"

# exec the wrangler bin directly (not `npx`, which forks wrangler as a child that then orphans on
# teardown) so Playwright's stop signal lands on the actual server process and its children are reaped.
#
# W71 — resolve the bin instead of hard-coding the workspace path. npm is free to dedupe a workspace
# dependency's bin up to the repo root, and it did: pinning miniflare reshuffled hoisting, this line
# became "No such file or directory", and Playwright reported it as a bare `Exit code: 127` from a
# webServer that had already printed four screens of successful seeding. `require.resolve` is not an
# option — wrangler's package `exports` does not expose ./bin/wrangler.js — so check both places npm
# actually uses, and say which ones were tried when neither works.
WRANGLER_BIN="./node_modules/.bin/wrangler"
[ -x "$WRANGLER_BIN" ] || WRANGLER_BIN="../../node_modules/.bin/wrangler"
[ -x "$WRANGLER_BIN" ] || {
  echo "e2e-serve: no wrangler bin at ./node_modules/.bin/wrangler or ../../node_modules/.bin/wrangler — run npm install" >&2
  exit 1
}
exec "$WRANGLER_BIN" pages dev dist --port "$PORT" --persist-to "$STATE"

#!/usr/bin/env bash
# Reap any leftover e2e webServer before a run. Playwright's own teardown misses these when the test
# process is SIGKILLed or a run is abandoned mid-flight (e.g. a subagent that walked away), so without
# this they orphan on port 8788 and accumulate across runs until they pin the CPU. Running this first
# makes every e2e run self-heal: the port is always free and stale wrangler/esbuild are gone.
set -uo pipefail

# Overridable so the ownership guard can be exercised against a scratch port
# (tests/unit/e2e-clean.test.ts). Every real caller uses the default, which Playwright's baseURL
# also hardcodes.
PORT="${E2E_PORT:-8788}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Every kill below is scoped to processes whose working directory is THIS checkout.
#
# W74 — it used to `pkill -f "wrangler pages dev dist --port 8788"` and pipe a bare `lsof -ti tcp:8788`
# into `kill -9`, neither scoped to anything. That made "self-heal" mean "kill whoever else is there":
# a second agent, or the CI runner mid-run, died silently so this one could have the port. It worked
# only because there was exactly one actor, and it was the reason there could only be one.
#
# Skipping a foreign owner beats killing it. "port busy, owned by <path>" is something a person can act
# on; a dead neighbour is a mystery at both ends.
. "$(dirname "$0")/port-lib.sh"

kill_owned() {
  local sig="$1" pid
  for pid in $(port_holders); do
    if owns "$pid"; then
      kill "$sig" "$pid" 2>/dev/null || true
    else
      echo "e2e-clean: port ${PORT} is held by pid ${pid} from $(pid_cwd "$pid") — NOT killing it." >&2
      echo "e2e-clean: that is another checkout or another agent. Stop it there, or wait." >&2
    fi
  done
}
kill_owned -TERM
sleep 0.4
kill_owned -KILL

# Orphaned esbuild spawned from THIS repo's wrangler (can outlive its parent when detached). This step
# was ALREADY path-scoped, which is where the pattern above came from.
pkill -f "${ROOT}/node_modules/@esbuild" 2>/dev/null || true

exit 0

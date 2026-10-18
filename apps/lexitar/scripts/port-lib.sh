# Who holds the e2e port, and is it us? Sourced by e2e-clean.sh and e2e-serve.sh.
#
# W74 — before this, "the port is busy" had exactly one response: kill whatever is there. That is
# defensible when one machine runs one suite, and it was wrong the moment a second agent (or the CI
# runner, which had its own clone) existed. Both scripts now need the same question answered —
# *whose* process is that — so it lives in one place rather than being spelled twice and drifting.
#
# Requires PORT and ROOT to be set by the caller.

# The working directory of a pid, empty if it cannot be determined.
pid_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

# True when the pid's cwd is inside this checkout.
owns() {
  local cwd
  cwd=$(pid_cwd "$1")
  case "$cwd" in "$ROOT"|"$ROOT"/*) return 0 ;; *) return 1 ;; esac
}

port_holders() { lsof -ti "tcp:${PORT}" 2>/dev/null || true; }

# Print a line per foreign holder of PORT. Empty output means the port is ours or free.
foreign_holders() {
  local pid
  for pid in $(port_holders); do
    owns "$pid" || echo "pid ${pid} (cwd: $(pid_cwd "$pid" || true))"
  done
}

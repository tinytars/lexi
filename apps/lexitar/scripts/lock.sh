# W75 — a mutex for the operations that are not idempotent when two of them overlap.
#
# Sourced, not executed:  . "$SCRIPT_DIR/lock.sh"; with_lock <name> <command...>
#
# The two callers are the ones where an overlap does damage rather than wasting work:
#   * the snapshot run, whose retention prune LISTS the snapshots and then DELETES the ones it
#     listed — a second run completing in that window is deleted by a decision made before it
#     existed, and the newest backup is exactly the one at risk;
#   * d1-migrate --remote, where two applies race wrangler's migration ledger against one database.
#
# mkdir is the atomic primitive here: it either creates the directory or fails, with no window
# between the test and the create that `[ -e ]` + `touch` would leave open. flock is not on macOS.
#
# The lock is keyed by TARGET (database name, store prefix), not by worktree, because two worktrees
# pointed at one database are precisely the collision — and it lives outside any checkout so they
# can see each other. It is a same-machine guard only: it does not coordinate with another Mac or
# with CI, and it is not a substitute for the server-side conditional writes the vault path uses.
LOCK_ROOT="${PLOVER_LOCK_DIR:-${TMPDIR:-/tmp}/plover-locks}"
LOCK_STALE_SECONDS="${PLOVER_LOCK_STALE_SECONDS:-7200}"

with_lock() {
  local name="$1"; shift
  local dir="$LOCK_ROOT/${name//\//_}.lock"
  mkdir -p "$LOCK_ROOT"

  # A holder that died leaves the directory behind. Break it only when the recorded pid is gone,
  # or when it is older than the longest plausible run — never on age alone while a pid is alive.
  if [ -d "$dir" ]; then
    local pid age
    pid="$(cat "$dir/pid" 2>/dev/null || echo "")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "lock: '$name' is held by pid $pid — refusing to run two of these at once" >&2
      return 75 # EX_TEMPFAIL: try again later, this is not a bug
    fi
    age=$(( $(date +%s) - $(stat -f %m "$dir" 2>/dev/null || stat -c %Y "$dir" 2>/dev/null || echo 0) ))
    if [ -z "$pid" ] && [ "$age" -lt "$LOCK_STALE_SECONDS" ]; then
      echo "lock: '$name' is held (no pid recorded, ${age}s old) — refusing to run" >&2
      return 75
    fi
    echo "lock: breaking stale lock '$name' (pid ${pid:-none}, ${age}s old)" >&2
    rm -rf "$dir"
  fi

  mkdir "$dir" 2>/dev/null || { echo "lock: lost the race for '$name' — another run just took it" >&2; return 75; }
  echo "$$" > "$dir/pid"
  # shellcheck disable=SC2064 — $dir must expand now, while it is still in scope.
  trap "rm -rf '$dir'" EXIT INT TERM

  "$@"
}

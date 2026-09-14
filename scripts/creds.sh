#!/usr/bin/env bash
# Shared credential resolver. Credentials are NOT committed in this repo — they live in the
# plover-context repo (pablo-tech/plover-context) under infra/cloud/credentials/, which is the canonical
# single source of truth. Consumers source this file, then `load_creds <file>` to pull a secret set.
# Override the location on machines/CI without ~/.claude via PLOVER_CREDENTIALS_DIR.
PLOVER_CREDENTIALS_DIR="${PLOVER_CREDENTIALS_DIR:-$HOME/.claude/infra/cloud/credentials}"

# load_creds <file> — source a credentials file (auto-exporting its vars) or fail loudly.
load_creds() {
  local f="$PLOVER_CREDENTIALS_DIR/$1"
  if [ ! -f "$f" ]; then
    echo "creds: missing $f — clone the plover-context repo (pablo-tech/plover-context) into ~/.claude," \
         "or point PLOVER_CREDENTIALS_DIR at its infra/cloud/credentials dir." >&2
    return 1
  fi
  set -a; . "$f"; set +a
}

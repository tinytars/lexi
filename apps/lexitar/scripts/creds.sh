#!/usr/bin/env bash
# Shared credential resolver. Credentials are NOT committed in this repo — they live in the
# operator's private credential store, which is the canonical single source of truth. Consumers
# source this file, then `load_creds <file>` to pull a secret set.
# Override the location on machines/CI without that store already set up via PLOVER_CREDENTIALS_DIR.
PLOVER_CREDENTIALS_DIR="${PLOVER_CREDENTIALS_DIR:-$HOME/PabloTech/plover-keys}"

# load_creds <file> — source a credentials file (auto-exporting its vars) or fail loudly.
load_creds() {
  local f="$PLOVER_CREDENTIALS_DIR/$1"
  if [ ! -f "$f" ]; then
    echo "creds: missing $f — set up the operator's private credential store," \
         "or point PLOVER_CREDENTIALS_DIR at it." >&2
    return 1
  fi
  set -a; . "$f"; set +a
}

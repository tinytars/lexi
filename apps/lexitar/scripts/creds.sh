#!/usr/bin/env bash
# Shared credential resolver, bash half. Credentials are NOT committed in this repo — they live in
# the credential stores, which are the canonical single source of truth. Consumers source this
# file, then `load_creds <file>` to pull a secret set.
#
# Two stores since 2026-10-08, searched per file in this order: LexiTar's own
# (LEXI_CREDENTIALS_DIR, tinytars/lexi-keys) and the estate's shared one
# (PLOVER_CREDENTIALS_DIR, promontory-studio/plover-keys). They hold DIFFERENT files rather than
# two copies of the same ones, which is why the lookup is per file and not a single directory
# chosen once — see scripts/creds-dir.ts for the reasoning; this is the deliberate duplicate of it,
# because a bash script cannot import TypeScript, and CREDENTIALS.md holds the two to each other.
#
# A cloner sets one variable and gets one store: the fallback is only ever consulted on a miss.
LEXI_CREDENTIALS_DIR="${LEXI_CREDENTIALS_DIR:-$HOME/PabloTech/lexi-keys}"
PLOVER_CREDENTIALS_DIR="${PLOVER_CREDENTIALS_DIR:-$HOME/PabloTech/plover-keys}"

# load_creds <file> — source a credentials file (auto-exporting its vars) or fail loudly.
load_creds() {
  local d f
  for d in "$LEXI_CREDENTIALS_DIR" "$PLOVER_CREDENTIALS_DIR"; do
    f="$d/$1"
    if [ -f "$f" ]; then
      set -a; . "$f"; set +a
      return 0
    fi
  done
  # Name the file and both variables. A message carrying one resolved path cannot tell a reader
  # which of the two stores they have not set up.
  echo "creds: no store holds $1. Searched:" >&2
  echo "  $LEXI_CREDENTIALS_DIR/$1" >&2
  echo "  $PLOVER_CREDENTIALS_DIR/$1" >&2
  echo "Point LEXI_CREDENTIALS_DIR at LexiTar's credential store (tinytars/lexi-keys), or" \
       "PLOVER_CREDENTIALS_DIR at the estate's (promontory-studio/plover-keys)." >&2
  return 1
}

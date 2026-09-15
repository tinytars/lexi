#!/usr/bin/env bash
# W44 P7 — the one wrangler wrapper. Sets up the out-of-repo env every headless wrangler call needs
# (homebrew Node on PATH, the CA bundle without which wrangler/SDK report "fetch failed", and the
# Cloudflare API token from the operator's private credential store), then runs wrangler with all args passed
# through. Use it for every wrangler invocation:  bash scripts/wrangler.sh d1 migrations list --remote
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Node lives under a custom homebrew prefix that isn't on the default PATH (mirrors .githooks/pre-push).
# Harmless if your Node is already elsewhere on PATH.
[ -d "$HOME/homebrew/bin" ] && export PATH="$HOME/homebrew/bin:$PATH"

# Without this, wrangler + the Anthropic SDK fail TLS verification ("fetch failed" / "Connection error")
# on this Mac. /etc/ssl/cert.pem is a macOS/BSD path.
#
# W74 — set it only when the file actually EXISTS. Node >=18 throws at startup on an unreadable
# NODE_EXTRA_CA_CERTS, so on Linux (where the bundle lives at /etc/ssl/certs/ca-certificates.crt)
# the old unconditional export made every wrangler call die before it began, with an error naming
# neither TLS nor this line. Linux needs no override: its default trust store already works.
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -r /etc/ssl/cert.pem ]; then
  export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem
fi

# Cloudflare API token comes from the operator's private credential store, not this repo.
. "$SCRIPT_DIR/creds.sh"
load_creds cloudflare.env \
  || echo "wrangler.sh: warning — cloudflare.env not loaded; wrangler will use ambient CLOUDFLARE_* env or interactive auth." >&2

exec npx wrangler "$@"

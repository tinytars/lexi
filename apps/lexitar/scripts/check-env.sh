#!/usr/bin/env bash
# npm run doctor / npm run doctor:prod — the fail-fast preflight.
#
# WHY THIS FILE EXISTS AT ALL, which is the uncomfortable half. Six documents have cited
# `npm run doctor` and `scripts/check-env.sh` for weeks — AUTH.md:68,84,130, BACKUP.md:16,133,
# VAULT.md:497,559 — and until 2026-10-08 neither existed. AUTH.md:130 did not describe a script
# vaguely; it stated its checks one by one. A document promising a command that answers nothing is
# worse than silence, because a reader who runs it and gets "Missing script" learns that the
# documentation cannot be trusted, and then stops reading the parts that are true. So this is
# written to the contract those documents already state, rather than the promise being deleted.
#
# WHAT IT IS FOR. "It just doesn't work" has about eight causes here and seven of them are
# environmental: Node not on PATH, a CA bundle override that kills every call, no credential store,
# a store with no cloudflare.env, a secret nobody provisioned on the environment you are pointed
# at, a STORE_PREFIX that disagrees with the checkout, a zero-byte vault fixture. Each one surfaces
# somewhere else as a different error that names none of them. This asks all of them in one pass.
#
# IT RUNS EVERY CHECK AND THEN REPORTS. Hence `set -uo pipefail` and no `-e`: a preflight that dies
# on the first fault makes you run it five times to learn five things. Exit is 1 if anything FAILED,
# 0 otherwise — a warning is not a failure, because the commonest honest state of this tree is a
# clone with no credential store, and that state must not look broken.
#
# THE REQUIRED SET IS DERIVED FROM THE CODE, NOT LISTED HERE. Every `env.NAME` under functions/ plus
# every `keyEnv` in inference.config.json — which is the only place the three model keys appear,
# since functions/_lib/inference/resolve.ts:33 resolves them dynamically and no route names them.
# A hand-kept list is the thing this is supposed to catch. The three classifications below say what
# is NOT a required secret — a binding, a plain var, or an optional one with a documented default —
# and everything else is required by default. That default is the load-bearing part: add
# `env.NEW_SECRET` to a route and it is required here from that commit, with nobody having edited
# this file, so the environment that lacks it fails a preflight instead of one route 500ing.
set -uo pipefail
cd "$(dirname "$0")/.."

PROD=0
[ "${1:-}" = "--prod" ] && PROD=1

pass=0; warned=0; failed=0
ok()   { printf '  ok    %s\n' "$*"; pass=$((pass+1)); }
warn() { printf '  warn  %s\n' "$*"; warned=$((warned+1)); }
bad()  { printf '  FAIL  %s\n' "$*"; failed=$((failed+1)); }
skip() { printf '  skip  %s\n' "$*"; }
head2() { printf '\n%s\n' "$*"; }

# ---------------------------------------------------------------- local environment

head2 "Toolchain"

# Mirrors scripts/wrangler.sh:12 and scripts/e2e-serve.sh:10 — Node under a custom homebrew prefix
# is not on the default PATH, and a launchd/cron job gets almost no environment at all.
[ -d "$HOME/homebrew/bin" ] && export PATH="$HOME/homebrew/bin:$PATH"

if command -v node >/dev/null 2>&1; then
  ok "node $(node --version) at $(command -v node)"
else
  bad "node is not on PATH. Everything below needs it; see BOOTSTRAP in the estate's context repo."
fi

# NODE_EXTRA_CA_CERTS is the one setting that breaks every call when it is WRONG rather than when it
# is absent: Node >=18 throws at startup on an unreadable path, before any of our code runs, with an
# error naming neither TLS nor the variable. /etc/ssl/cert.pem is the macOS/BSD bundle; Linux needs
# no override at all.
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
  if [ -r "$NODE_EXTRA_CA_CERTS" ]; then
    ok "NODE_EXTRA_CA_CERTS is set and readable ($NODE_EXTRA_CA_CERTS)"
  else
    bad "NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS is not readable — Node will refuse to start. Unset it."
  fi
elif [ -r /etc/ssl/cert.pem ]; then
  ok "CA bundle /etc/ssl/cert.pem present; scripts/wrangler.sh will export it"
else
  ok "no /etc/ssl/cert.pem — correct on Linux, whose default trust store already works"
fi

# ---------------------------------------------------------------- the local tree

head2 "This checkout"

if [ -f .dev.vars ]; then
  ok ".dev.vars present (gitignored at .gitignore:20)"
else
  warn ".dev.vars is absent. \`wrangler pages dev\` will serve with no secrets: inference, Google
        sign-in, passkeys and read-aloud all fail, while the unit and e2e suites still pass. Copy
        .dev.vars.example to .dev.vars. See CREDENTIALS.md."
fi

# VAULT.md:497 — a zero-byte vault.json reads as corrupted JSON ("Unexpected end of JSON input") on
# a file that was fine a moment ago, and the only thing that writes it is vite.config.ts's dev-only
# /__save-vault. Naming the file is the whole value; it is a committed fixture, so `git checkout --`
# recovers it.
empty_vaults=$(find records -name vault.json -size 0 2>/dev/null)
if [ -n "$empty_vaults" ]; then
  bad "zero-byte vault fixture(s) — this is what \`vault:verify\` reports as corrupted JSON:"
  printf '        %s\n' $empty_vaults
  printf '        recover with: git checkout -- %s\n' "$(printf '%s ' $empty_vaults)"
else
  ok "no zero-byte vault.json under records/"
fi

# ---------------------------------------------------------------- the credential store

head2 "Credential store"

. "$(dirname "$0")/creds.sh"
creds_ok=0
if load_creds cloudflare.env 2>/dev/null; then
  store=""
  for d in "$LEXI_CREDENTIALS_DIR" "$PLOVER_CREDENTIALS_DIR"; do
    [ -f "$d/cloudflare.env" ] && { store="$d"; break; }
  done
  ok "cloudflare.env resolved from $store"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    ok "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are both set"
    creds_ok=1
  else
    bad "cloudflare.env loaded but CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID is empty."
  fi
else
  # load_creds already printed the file, both searched paths and both variables to stderr. A clone
  # with no store is the ordinary case and is not a failure: it blocks deploys and remote reads, and
  # nothing else. CREDENTIALS.md's "What runs with nothing configured" is the measured list.
  warn "no store holds cloudflare.env (paths and variables above). Blocks: every remote wrangler
        command, snapshots, restores, and the deployed-environment checks below. Does NOT block the
        unit suite, the e2e suite, \`npm run check\`, \`npm run lint\` or \`npm run d1:migrate:local\`."
fi

# The org key is the operational keypair, and a JSON parse failure in it is indistinguishable from a
# lost key until something tries to use it. Ask cheaply, by hand, now.
orgkey=""
for d in "$LEXI_CREDENTIALS_DIR" "$PLOVER_CREDENTIALS_DIR"; do
  [ -f "$d/org-key.json" ] && { orgkey="$d/org-key.json"; break; }
done
if [ -z "$orgkey" ]; then
  skip "org-key.json — no store holds it; every vault:* command needs it, nothing else does"
elif node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$orgkey" 2>/dev/null; then
  ok "org-key.json parses ($(dirname "$orgkey"))"
else
  bad "org-key.json does not parse: $orgkey — every vault:* command will fail on it."
fi

# ---------------------------------------------------------------- what the code requires

head2 "Secrets the code reads"

# env.NAME under functions/, plus every keyEnv in inference.config.json. Both halves are needed:
# the model keys appear in NO route, only in that config, resolved at resolve.ts:33.
required_all=$(
  { grep -rhoE '\benv\.[A-Z][A-Z0-9_]{3,}' functions --include='*.ts' | sed 's/^env\.//'
    grep -oE '"keyEnv"[^]]*\]' inference.config.json | grep -oE '[A-Z][A-Z0-9_]{3,}'
  } | sort -u | tr '\n' ' '
)

# Classification. Every derived name lands in exactly one of these, and an unclassified one FAILS —
# which is the point: it means someone added `env.SOMETHING` to a route and this script is the thing
# that notices before an environment is missing it.
#
# BINDINGS come from wrangler.jsonc, never from .dev.vars or a secret store (CREDENTIALS.md:56-57).
bindings="ASSETS VAULT DB"
# NOT_SECRET are plain vars, also from wrangler.jsonc: the store a deploy acts on and whether every
# inference is made in sight of the patient's own reports.
not_secret="STORE_PREFIX REPORTS"
# OPTIONAL have a documented default or a documented fallback, so absence is correct, not a gap:
#   EMAIL_FROM                 — functions/_lib/email.ts:107 defaults it
#   FINDING_/RANGES_…          — fall back to ANTHROPIC_API_KEY (inference.config.json:12,18)
#   GOOGLE_AUTH_URL/TOKEN_URL  — exist so a test can point the exchange at a local stub; they are
#                                deliberately UNSET in every real environment (CREDENTIALS.md:56-58)
optional="EMAIL_FROM FINDING_ANTHROPIC_API_KEY RANGES_ANTHROPIC_API_KEY GOOGLE_AUTH_URL GOOGLE_TOKEN_URL"

in_list() { case " $2 " in *" $1 "*) return 0;; esac; return 1; }

required=""
for n in $required_all; do
  in_list "$n" "$bindings"   && continue
  in_list "$n" "$not_secret" && continue
  in_list "$n" "$optional"   && continue
  required="$required $n"
done
required=$(echo $required)
ok "derived $(echo "$required" | wc -w | tr -d ' ') required secrets from functions/ and inference.config.json"

# ---------------------------------------------------------------- the deployed environment

if [ "$PROD" = 1 ]; then
  head2 "Deployed environment: production"
else
  head2 "Deployed environment: this branch's project"
fi

project=""
if [ "$PROD" = 1 ]; then
  # Not hardcoded: wrangler.jsonc is DELIBERATELY divergent between dev and main (wrangler.jsonc:3-5),
  # so main's copy IS production's definition and asking git for it cannot drift. The override is for
  # a shallow clone with no origin/main.
  project="${LEXI_PROD_PAGES_PROJECT:-}"
  if [ -z "$project" ]; then
    project=$(git show origin/main:apps/lexitar/wrangler.jsonc 2>/dev/null \
      | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  fi
  [ -z "$project" ] && bad "cannot resolve the production Pages project: no origin/main in this
        clone and LEXI_PROD_PAGES_PROJECT is unset. Fetch origin/main, or set that variable."
else
  project=$(grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' wrangler.jsonc | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  [ -z "$project" ] && bad "wrangler.jsonc names no Pages project."
fi

pages_env() { # $1 = production|preview — prints "NAME type" per line
  curl -sS --max-time 25 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$project" \
  | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const j = JSON.parse(s);
        if (!j.success) { console.error(JSON.stringify(j.errors)); process.exit(2); }
        const vars = (j.result.deployment_configs?.[process.argv[1]] || {}).env_vars || {};
        // A secret_text value is never returned by this endpoint; a plain_text one is public config.
        for (const [k, v] of Object.entries(vars))
          console.log(k + " " + ((v && v.type) || "unknown") + " " + ((v && v.value) || ""));
      });' "$1"
}

if [ "$creds_ok" != 1 ] || [ -z "$project" ]; then
  skip "Pages environment checks — they need cloudflare.env and a resolved project name"
else
  prod_env=$(pages_env production 2>/dev/null)
  if [ -z "$prod_env" ]; then
    bad "could not read $project's production environment from the Cloudflare API."
  else
    names=$(echo "$prod_env" | awk '{print $1}' | sort -u)
    missing=""
    for n in $required; do in_list "$n" "$(echo $names)" || missing="$missing $n"; done
    if [ -n "$missing" ]; then
      bad "$project production is missing $(echo $missing | wc -w | tr -d ' ') secret(s) the code reads:$missing"
    else
      ok "$project production provisions all $(echo "$required" | wc -w | tr -d ' ') required secrets"
    fi

    # AUTH.md:68 — a live credential with no reader is exposure with no counterpart in capability,
    # and the two that were kept provisioned "so the environments stayed diffable" are exactly how
    # that happens. Re-provision one by hand and this says so.
    stale=""
    for n in $names; do
      in_list "$n" "$required_all" && continue
      in_list "$n" "$(echo $required)" && continue
      stale="$stale $n"
    done
    [ -n "$stale" ] && warn "$project provisions name(s) nothing in this tree reads:$stale
        (CREDENTIALS.md's \"Measured dead\" is where a deliberate one is recorded.)"
    [ -z "$stale" ] && ok "no provisioned name is unread by this tree"

    # VAULT.md:559 — STORE_PREFIX decides every R2 key, so a project whose prefix disagrees with the
    # checkout is one `npm run` away from writing dev keys into prod's bucket.
    want_prefix=$(echo "$prod_env" | awk '$1=="STORE_PREFIX"{print $3}')
    if [ "$PROD" != 1 ]; then
      local_prefix=$(grep -oE '"STORE_PREFIX"[[:space:]]*:[[:space:]]*"[^"]+"' wrangler.jsonc \
        | sed 's/.*"\([^"]*\)"$/\1/')
      if [ -n "$want_prefix" ] && [ "$want_prefix" = "$local_prefix" ]; then
        ok "STORE_PREFIX agrees: $local_prefix in wrangler.jsonc and in $project"
      else
        bad "STORE_PREFIX disagrees: wrangler.jsonc says '$local_prefix', $project says '$want_prefix'."
      fi
    else
      ok "$project production STORE_PREFIX is '$want_prefix'"
    fi

    # Measured 2026-10-08 and deliberate: preview carries only the two PLAIN vars on both projects,
    # which is why a per-deployment preview URL answers a bare 503 on Google sign-in (start.ts:33-36).
    # That is a property, not a gap — a preview build is reachable by URL and holds no secret.
    prev_secrets=$(pages_env preview 2>/dev/null | awk '$2=="secret_text"{print $1}')
    if [ -z "$prev_secrets" ]; then
      ok "$project preview carries no secrets — deliberate; a preview URL 503s on sign-in by design"
    else
      bad "$project preview carries secret(s): $(echo $prev_secrets). A preview build is reachable
        by URL; see CREDENTIALS.md on why preview is deliberately empty."
    fi
  fi
fi

# ---------------------------------------------------------------- the backup

head2 "Backup freshness"

# BACKUP.md:16,133 — the scheduled snapshot is in .github/workflows/snapshot.yml, and a backup that
# quietly stops is worse than none, so freshness is re-asked here, on a path independent of the job.
if [ "$creds_ok" != 1 ]; then
  skip "npm run vault:snapshot:check — needs cloudflare.env"
elif [ "$PROD" = 1 ]; then
  # scripts/target.ts refuses when STORE_PREFIX and the checkout's wrangler.jsonc disagree, which is
  # the guard working: prod's bucket is named in main's wrangler.jsonc and not in this one.
  skip "npm run vault:snapshot:check for prod — run it from a \`main\` checkout, where
        wrangler.jsonc names prod's bucket (scripts/target.ts refuses the mismatch deliberately)"
elif npm run --silent vault:snapshot:check; then
  ok "a fresh snapshot exists for this branch's store"
else
  bad "no fresh snapshot for this branch's store — see BACKUP.md."
fi

# ---------------------------------------------------------------- verdict

printf '\n%s ok, %s warn, %s FAIL\n' "$pass" "$warned" "$failed"
[ "$failed" -gt 0 ] && exit 1
exit 0

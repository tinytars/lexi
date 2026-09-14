# Building health-dash-web

App-specific working rules for `apps/health-dash-web`. The repo-wide policy lives in the
root `CLAUDE.md`; this file holds what is specific to the dashboard app. Planning docs for
this app live in `plover-context`, at `~/.claude/planning/plover-code/docs/health-dash/plans/`
(roadmap = `00-roadmap.md`) — moved out of this repo 2026-09-12, per `~/.claude/CLAUDE.md` "Planning".

## Translate / regeneration

`docs/TRANSLATE.md` — the vocabulary (Translate = one turn's reply, always available; the sweep;
Translate all = provider-only), and the explicit list of every condition that blocks a leaf
Translate. Read it before adding anything to a DAG node's input closure or any new cost gate:
staleness is a **gate** on Translates, not just a badge, so a change that marks computed ancestors
stale silences turn replies.

## Vault / PHI security (app-specific detail)

This is a **private** repo and, by the owner's decision, secrets and data **may** be committed
(the repo-wide statement of this is in the root `CLAUDE.md`). For this app specifically:

- **Plaintext patient data (PHI)** is committed under `records/private/` (raw originals,
  `processed/` extractions, and `vault.json` / `roster.json`). This is the W13 source of truth —
  at rest, openable in VS Code, and key-loss-proof; the served `records/public/*.enc` is the
  encrypted, derived copy. See `VAULT.md`.
  - W46 — `records/private/{id}/raw/` also holds every leaf **attachment** (a note/treatment/etc's
    attached photo or document, uploaded via the same `/api/raw/{id}/{key}` PUT as a report
    original), not just imported clinical reports. They carry the same plaintext-PHI posture as
    raw reports — a wound photo is more sensitive than a lab PDF, and this is the deliberate,
    owner-accepted model (`functions/api/raw/[[path]].ts`) — so the purge below covers them too.
  - **Attached documents add a second R2 prefix, `text/{id}/{key}.json`** — the transcription of an
    attached PDF/text file, written once at attach time by `/api/document-extract` and served back
    to whichever surface answers a patient turn. It is **plaintext PHI in the same sense `raw/` is**,
    under the same session gate and in the same bucket, so it inherits the same posture and the same
    purge. It lives outside the vault deliberately: a long PDF's text in a vault blob would be
    re-encrypted and rewritten on every unrelated edit, so the vault carries only
    `Attachment.extracted` metadata (`types.ts`) — never the text. Content-addressed like `raw/`, so
    re-attaching the same bytes anywhere reuses the extraction and never bills a second read.
- If the repo's visibility ever changes to public, **purge `records/private/` from git history**
  (plaintext PHI cannot be "rotated" — it must be expunged; `git filter-repo` procedure in
  `RECOVERY.md`) in addition to rotating every committed credential.

## `miniflare` is pinned, and must stay pinned

Every unit test that instantiates `new Miniflare(...)` directly (32 files as of 2026-08-29, and
growing) does so to get a real workerd D1/R2 to run the Pages Functions against. Until W71
`miniflare` was **not declared in any `package.json`** — the tests simply imported whatever version
`wrangler` happened to ship transitively.

On 2026-08-24 a routine `npm audit fix` bumped `wrangler` 4.105.0 → 4.125.0, which pulled `miniflare`
5.x **alpha**, whose constructor moved `modules`/`script` under a `workers: [...]` array. All 23
Miniflare-backed files that existed at the time failed typecheck and threw `ERR_VALIDATION` at
runtime, and `dev` went red — for a change that had nothing to do with the test harness.

`miniflare` is now an exact-pinned devDependency (`4.20260625.0`). Consequences to know:

- **Do not run `npm audit fix` and assume it is safe here.** Check whether it moved `miniflare`.
- The pin holds back a **high** `undici` advisory reached only through `miniflare`. It is **dev-only** —
  `npm audit --omit=dev` reports no `undici` at all, and its sole `effects` entry is `miniflare`. That
  is the accepted cost of not running the test harness on an alpha.
- Moving to `miniflare` 5 is a real piece of work (23 harnesses to the new `workers` API) and should be
  its own change, done when 5.x is stable — not as a side effect of an audit fix.

## Cheap-execution model (default for substantial milestones)

A single long Opus turn re-sends its whole transcript each step, so cost grows ~quadratically.
Structure any substantial milestone this way (playbook:
`docs/health-dash/plans/32-real-time-web-ingestion-and-cheap-execution.md`):

- **One turn per phase** (types → UI → entry → finding → tests), `/clear` between; the plan file
  is the handoff.
- **Delegate file-heavy mapping** to the `health-dash-explorer` subagent (read-only; returns
  `file:line` conclusions, not file dumps) — keep large files out of the main context.
- **Run the verification gate once, at the end**, via the `health-dash-gatekeeper` subagent
  (build + test:all + vault:verify with the right env), which returns only pass/fail + first
  failures.
- Use a `Workflow` for genuine repeated-pattern fan-out. Prefer targeted `Read`; don't re-read a
  just-edited file; trust the Stop-hook cost report (never estimate).

Both subagents are defined in `.claude/agents/` (auto-loaded in a fresh session).

## Testing discipline (W75, 2026-08-26)

Four rules that came out of auditing twelve milestones' claims against the code. They are the
standing answer to "is this test worth having", not advice.

1. **A test that would pass without the property is not a test.** Remove the property and confirm the
   test goes red before committing it. Where the risk is a call site *drifting back* to a hand-rolled
   copy rather than a behaviour changing, no behavioural test can see it — use a **source-grep
   assertion** instead (`tests/unit/leaf-id-pairing.test.ts` is the precedent: it greps to prove
   `validateLeafResult` is the single gate).
2. **Coverage is a report, not a ratchet.** `npm run coverage` runs in the gate and writes a table to
   the job summary with **no threshold, deliberately**. A percentage is never a verdict. A ratchet
   buys tests written to move a number, which is exactly rule 1's failure. Read the report
   file-by-file and judge a milestone by which cold blocks shrank. The number is also only as honest
   as its denominator — excluding `src/lib/**/*.svelte` had been hiding `App.svelte`, 63 components
   and every `.svelte.ts` rune module, flattering it by 19 points.
3. **Count, never delete, what you cannot attribute.** Ownership is first-writer-wins, so an unowned
   object may belong to another patient. Erasure, snapshot pruning and every operator script that
   deletes must report **incomplete** rather than deleting by prefix — and a compliance-facing
   `complete: true` must be derived from the set actually erased, not a store-wide count.
4. **Absence is a failure mode.** Every other alarm here watches for something going red; a check
   that never ran looks identical to success (`gh pr checks` reports success on an empty set).
   `.github/workflows/tip-watch.yml` exists for that, and the same question applies to any nightly:
   a job that stops firing reports nothing, forever.

Written up in full: `docs/health-dash/plans/75-w75-prove-what-we-claim.md`.

## In-flight requests are intercepted suite-wide in e2e (W76, 2026-08-27)

**Any request still in flight when a Playwright context tears down kills `wrangler pages dev`**
outright — a reload severing a large PUT, plain test teardown, or an unawaited background call
(`/api/leaf-regen`) all trigger the same wrangler ProxyWorker fatal. It surfaces as
`THE SERVER … IS DEAD` plus a **blank** `✘ [ERROR]`; the `Failed to drain the unused request body`
line that follows is a red herring. There is no server-side fix — the lever is test-side.

**Rule:** every spec imports `test` from `./_fixtures`, not `@playwright/test`. Its suite-wide
auto-fixture answers the three routes that can never succeed in CI — `/api/vault/*` (capture PUTs,
replay GETs), `/api/leaf-regen` (background, no `RANGES_ANTHROPIC_API_KEY`), `/api/raw` and
`/api/chat-history` (blobs/history that only exist outside the repo). A spec whose subject IS one of
these round-trips opts out explicitly (`providers-access`, `providers-support` import
`@playwright/test` directly, with a comment why). When the next such route shows up: if it's called
in the background, unawaited by the assertion, and cannot succeed in CI anyway, answer it in the
fixture rather than letting it fail across a real connection.

Full forensic writeup (three falsified theories, the measured PUT-count threshold, the wrangler-log
tells, the route-by-route failure table): [`E2E-HISTORY.md`](E2E-HISTORY.md).

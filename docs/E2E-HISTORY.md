# e2e incident history — health-dash-web

Dated post-mortems for e2e-suite failures whose root cause and fix are non-obvious enough to be
worth a full writeup. `BUILDING.md` keeps only the durable rule each of these produced, with a
pointer back here — this file is the "why," not live policy.

## In-flight requests are intercepted suite-wide in e2e (W76, 2026-08-27)

**A `page.reload()` that severs an in-flight whole-vault PUT kills `wrangler pages dev` outright.**
This was the gate's chronic shard failure for weeks, and it is a wrangler dev-server bug rather than
one of ours — but the trigger is a test-authoring pattern, so the rule lives in `BUILDING.md`.

The chain, reproduced directly rather than inferred:

1. A mutation immediately chains a whole-vault PUT (~472 KB — `vault-save.svelte.ts` has no debounce).
2. `page.reload()` cuts that PUT mid-body.
3. Wrangler's **ProxyWorker** — its own layer between the HTTP listener and workerd, nothing to do
   with our Functions — raises `Error: Network connection lost.` on the broken forwarding stream, and
   `ProxyController.emitErrorEvent` treats it as fatal. The process exits.

**Do not be misled by the `Failed to drain the unused request body` line that follows.** It was the
first thing found and it is a red herring: `middleware-ensure-req-body-drained.ts` wraps its drain in
`try/catch` and only `console.error`s, so it can never kill anything. The **blank** `✘ [ERROR]` is
the real fault and it prints FIRST, before the route's own 401 log. Cancelling the request body on the
Function's early-return paths was tried and does **not** help — the repro still died after 5 severed
PUTs. There is no server-side fix; the lever is test-side (do not sever) or upstream in wrangler.

It surfaces as `THE SERVER … IS DEAD` and a **blank** `✘ [ERROR]` — the quietest possible signature,
which is most of why it took so long to find.

**Measured, both directions, in seconds on a laptop:** 5 severed 472 KB PUTs kill the dev server;
**60 complete PUTs of the same size do not.** The abort is the trigger, not the traffic.

Consequences:

- **The trigger is any test ENDING over an unsettled large write, not just a reload.** A test's
  context teardown severs in-flight requests exactly like a reload does — which is how
  `permalink.spec.ts`, a file with no `page.reload()` and no `page.goto()`, killed a shard. Only
  large PUTs are exposed: a small body completes in one segment and is never caught mid-stream.
- **Every spec imports `test` from `./_fixtures`, not from `@playwright/test`.** That module's
  `vaultGuard` auto-fixture routes `**/api/vault/*` on the CONTEXT: PUTs are captured and answered
  204, GETs replay the captured bytes and otherwise fall through. Per-spec patching was tried first
  and did not hold — `search-content`, `permalink` and `notes` each killed a shard in turn, sharing no
  pattern except writing and then ending, which is what made the suite-wide fixture the right unit.
- **What that costs, stated plainly:** a reload assertion still proves the client sent the right bytes
  and re-renders them, but no longer proves the SERVER persisted them.
- **`**/api/vault/*` also matches the SIBLING routes** under `functions/api/vault/` — `org-key`,
  `principals`, `recovery-envelope`, `rotate`. They are not vault blobs, and answering their PUTs 204
  breaks recovery and access-granting in ways that read as product bugs rather than as test-harness
  bugs (`recovery.spec.ts` timed out on a click). The fixture skips them by name.
- **So a spec whose subject IS the round-trip must opt OUT** by importing `test` from
  `@playwright/test` directly, with a comment saying why. Two do: `providers-access` and
  `providers-support` — both revoke access, which re-keys the vault, and both then assert a fresh
  login still opens it. Opting out is safe for them because they run on fresh signups, whose vaults
  are too small to be caught mid-stream. **This is not optional bookkeeping**: `providers-support`
  failed loudly under interception, and `providers-access` did something worse — it kept passing,
  vacuously.
- **Do not over-exclude either.** The first exclusion list had three names; one (`support-provider-roster`)
  was only a casualty of the sibling-route bug above and belongs on the fixture. An unnecessary
  exclusion is a spec left exposed to the crash for no gain.
- **Rank the exposure from the source, not from the crash logs**: specs that both write unstubbed and
  reload. That ranking is what identified `shell-study-hypothesis.spec.ts` (5 reloads; next highest 3)
  independently of which file happened to die.
- **Do not conclude from which single test dies.** Quarantining the suspect test moved the death to a
  sibling in the same file with an identical signature. The unit at fault is the *file's* pattern.
- **No production exposure.** The ProxyWorker exists only in `wrangler pages dev`.

**One test was passing by race, and the fixture exposed it.** `cover-render.spec.ts` asserts the
dashboard renders with no console errors, while Pablo's vault references four real attachment blobs
(~200 KB medication-label photos) that exist only in the deployed R2. Dev and CI structurally cannot
have them — seeding would mean copying PHI into the repo or onto a runner — so the `<img>` 404s were
always happening; they simply landed outside the assertion window five times in six. Resolving the
vault from memory renders sooner and lost that race every time. The fix forgives a `Failed to load
resource` console error **only when every 404 seen is under `/api/raw/`**, verified by mutation: a
404 on `/api/account/methods` still turns it red. Do not widen that to all 404s.

Three theories were falsified before this one — a `route.fetch()` pass-through, the runner's memory
ceiling, and the wrangler version. Each was asserted from correlation and each survived several green
runs before failing again. A local reproduction with a control settled in minutes what a dozen CI
dispatches could not.

### The second source: background `/api/leaf-regen` (found 2026-08-27, after the vault fix)

Intercepting vault writes was necessary and **not sufficient**. Run `33067014364` still lost `e2e (9)`
— twice, at the same test both times, which is what made it worth chasing rather than retrying. The
tell was not in the Playwright output, which only says the server is dead; it was in the uploaded
`wrangler-logs-e2e-9` artifact, where both crashes carry an identical prelude: three or four
`{"route":"/api/leaf-regen","status":502,"errorCode":"anthropic_error"}` lines, then
`Error in ProxyController` / `Network connection lost.` about 0.4s later.

**So the mechanism is more general than "a large severed body", and the earlier write-up understated
it.** A big PUT is simply the widest window; what actually kills the dev server is *any* request
still in flight when the browser context tears down. Background AI calls qualify: they fire in
bursts, nothing awaits them, and a test that ends promptly ends over several of them.

The confirming detail is that the deaths were not random. `shell-study-hypothesis.spec.ts` stubs
leaf-regen inside its `:57` test only — and `:128`, `:158`, `:194`, the three tests with no stub, are
exactly the three that died.

`_fixtures.ts` therefore answers `**/api/leaf-regen` at the context level with the identical
`502 anthropic_error` the route already produces. **This mocks nothing:** CI holds no
`RANGES_ANTHROPIC_API_KEY`, so every real call already 502s in 3-45ms. The stub removes the trip
across the wire, not a behaviour any test was asserting. The thirteen specs that own leaf-regen
register `page.route`, which is matched before context routes, so each keeps winning untouched.

**The rule this generalises to, for the next route that does this:** if an endpoint is called in the
background, is not awaited by the assertion, and cannot succeed in CI anyway, answer it in the fixture.
Leaving it to fail across a real connection buys no coverage and costs a shard.

### Applying that rule to the whole route table, instead of one route at a time

The leaf-regen fix held — it vanished from the next crash's prelude — and a *third* source took its
place: `/api/raw`, the attachment blobs. Pablo's vault references real medication-label photos that
live only in the deployed R2, so every `<img>` fires a GET that 404s, in bursts of four to eight as a
cover renders.

Two rounds of whack-a-mole were enough. Tallying every route/status pair across the shard-2 and
shard-9 wrangler logs answers it in one pass — **exactly three routes ever fail in this environment**:

| route | calls | status | why it cannot succeed in CI |
|---|---|---|---|
| `/api/raw` | 166 | 404 every time, no 200 | blobs exist only in the deployed R2; seeding them means PHI on a runner |
| `/api/leaf-regen` | 97 | 502 `anthropic_error` | no `RANGES_ANTHROPIC_API_KEY` |
| `/api/chat-history` | 40 | 404 every time | nothing seeds it |

Everything else — `/api/account`, `/api/vault`, `/api/auth/*`, `/api/providers*` — returns 200 and is
genuinely exercised. Those must keep reaching the server; intercepting them would be the vacuity
trap, not a fix.

All three are answered in `_fixtures.ts`. `/api/raw` GETs get the same 404 (PUT falls through — it is
a real upload `import.spec.ts` asserts on). `/api/chat-history` gets capture-and-replay like the
vault, so a spec that writes history still reads back its own bytes. **`/api/chat-history` went in on
the rule, not on evidence** — it never appeared immediately before a crash — and that is worth
knowing if it ever needs revisiting.

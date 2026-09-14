# Architecture

The orientation document: what the pieces are, where the trust boundary sits, and which of the
eighteen other markdown files in this directory answers which question. Written 2026-08-24 (W72) —
there was a documentation map in `README.md` but no map of the *system*, and the reading order it
gives had gone stale.

`VAULT.md` remains the authority on storage and the encryption boundary. This document is the layer
above it: how a request moves, and where to start reading.

## Runtime topology

```
  Browser (Svelte 5 SPA)                     Cloudflare Pages
  ├─ decrypts the vault in-page              ├─ Functions (functions/api/**)
  ├─ holds the DEK, in memory only           │   ├─ session + authorisation (D1)
  ├─ builds every clinical prompt            │   ├─ blob read/write (R2, conditional)
  └─ talks only to same-origin /api/*        │   └─ relays to Anthropic, holding the API key
                                             ├─ R2  — ciphertext vaults, plaintext raw uploads
                                             └─ D1  — accounts, envelopes, provider links, audit
  CLI (scripts/**)
  └─ same clinical modules, direct to R2/D1/Anthropic — no Function in the path
```

**Three runtimes, one set of clinical modules.** `src/lib` is imported by the browser, by the Pages
Functions and by the Node CLI. That is deliberate and it is the invariant most worth protecting: when
the same reasoning existed twice, it drifted, and the drift shipped (see `docs/cross-app/06`, and W72's
`correctionSuffix` — the CLI got a retry fix in W67 that the browser path did not).

## The trust boundary

**Plaintext PHI exists in exactly three places**: in the patient's browser, in R2 under `raw/` (the
original uploads, deliberately unencrypted), and in this repository under `records/private/`.

Everywhere else it is ciphertext the server cannot open. `SECURITY.md` states the claim, what enforces
it, and the gaps that are open today — read it before reviewing anything in `functions/`.

## The Finding, and the DAG

The distinctive part of this codebase, and the part that repays reading first.

A patient's **Finding** is a structured clinical read assembled from one large "core" model call plus
**nine leaf calls**, each owning specific sections. `src/lib/finding-dag.ts` declares the dependency
graph; every node carries a hash of its own raw-input closure, so editing one datum marks exactly the
nodes downstream of it stale and nothing else.

Three consequences worth knowing before changing anything here:

- **Staleness is a gate, not a badge.** A stale computed ancestor *blocks* a leaf regeneration. Get
  this wrong and a patient writes a note and gets silence — which W71 did twice before landing.
- **Leaves own their sections.** The core cannot narrate them, so replacing a Finding with a freshly
  assembled core blanks all nine until each leaf runs.
- **Answers pair by id, not by name.** W67 converted four sections and W71 the fifth; `treatment` was
  the last one matched by a name the model wrote itself, which cost `treatment-bucket.ts` 25 changes
  in 403 lines.

`docs/TRANSLATE.md` defines the vocabulary ("Translate" is one turn; "Translate all" is the whole
Finding). `src/lib/leaf-regen-registry.ts` is the one place a leaf's prompt, validation, input check
and merge live together.

## Where the code is

| Path | Lines | What |
|---|---|---|
| `src/lib` | ~27k | Clinical reasoning, prompts, crypto, the Svelte components. Shared by all three runtimes |
| `functions` | ~6.8k | Pages Functions: auth, authorisation, storage, AI relays |
| `scripts` | ~6.1k | The CLI — ingest, vault sync/snapshot/restore, generation |
| `tests` | ~28.6k | Unit + e2e. Larger than `src/lib`, deliberately |
| `brain/neuro-pil` | — | Extracted, generic DAG/hashing library (`@pablotech/neuro-pil`) |
| `packages/` | — | `@tars/brand`, `@tars/styles`, `@tars/qbo` |

Two extractions are scheduled and will move much of the above: `docs/cross-app/06` (the clinical brain)
and `docs/cross-app/10` (the security layer). Read those before any large refactor of `src/lib`, or
you will conflict with them.

## Verifying a change

```
npm run lint      # oxlint, --deny-warnings, zero findings (LINTING.md)
npm run check     # svelte-check + tsc — the only type-level gate
npm test          # unit suite
npm run coverage  # measurement, no threshold
npm run build     # catches a third class the others cannot (CSS inside a {@html} literal)
```

**Read the exit code, never a grep** — `check` runs two tools that print different formats.

**Prefer not to run e2e locally.** The reason changed in W74: it no longer fights CI, because the
self-hosted runner is retired and the suite runs sharded on GitHub. What remains is that it binds
port 8788 — so a second agent, or an interactive `dev:functions`, still collides — and that the suite
is memory-hungry enough to have been killed repeatedly on a 16 GB machine that was also running a
browser and an editor. If you must, run `--project=synthetic`: 9 specs, no credentials, no pilot data.

### Generated artifacts

Three things in the tree are generated and checked in, each guarded by a test that fails when it has
drifted. **None of them may be regenerated to make a build green** — a failure means the thing they
describe changed, and the question is whether that change was intended.

```
npm run prompt:golden    # tests/fixtures/prompt-golden/ — the clinical prompt text, per variant
npm run brain:versions   # src/lib/brain-versions.ts — the version hash stamped onto AI output
```

`tests/fixtures/canonical-golden.json` (the staleness canonicalizer) is the third, with its own
committed generator. A deliberate change regenerates the artifact in the **same commit** as the change
that caused it, with a message saying why — so review sees the cause and the effect together.

`brain:versions` deserves its own note: the map is stamped onto every Finding section as
`promptVersions`, which is how a stored answer is joined back to the reasoning that produced it. A
stale map does not fail loudly at runtime — it silently attributes a section to a prompt that has since
been rewritten. That is why the freshness check is a unit test and not a convention.

## Two plan series, one number space — a live hazard

Plans live in **two** directories with **seventeen colliding numbers** describing unrelated work.
Both moved to `plover-context` on 2026-09-12 (`~/.claude/CLAUDE.md` "Planning") — mirrored under
`~/.claude/planning/plover-code/`, same relative paths as before:

| | Directory (now under `~/.claude/planning/plover-code/`) | Convention |
|---|---|---|
| Milestones | `docs/health-dash/plans/` | `NN-wNN-slug.md` — **W-prefixed** |
| UI/UX iterations | `apps/health-dash-web/docs/plans/` | `NN-slug.md` — no prefix |

So "46" is *attachments and previews* as a milestone and *self-service onboarding* as an iteration;
70, 71 and fourteen others collide the same way. **Cite the path, never the bare number.** Renumbering
sixty files would break every cross-reference in both series, so this is documented rather than fixed —
but it is a real trap for anyone new, and `README.md`'s doc map points at only one of the two.

## Where to start reading

1. `SECURITY.md` — the claim and the open gaps
2. `VAULT.md` — data model and encryption boundary
3. this document — how a request moves and how the Finding is built
4. `~/.claude/planning/plover-code/docs/health-dash/plans/00-roadmap.md` — status and direction
5. `API.md` — the HTTP contract, including the authorisation gap recorded in it

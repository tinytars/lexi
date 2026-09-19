# Architecture

This is the contract, not a tour — see `README.md`'s **What it does** for the featureset summary
an architect scans first. What follows is what a reader needs to trace a bug through the vault
boundary, add a parser, or judge whether a change to the derived-reasoning pipeline is safe.

`apps/lexitar` is a consumer, not a from-scratch build: the reusable crypto/access-policy layer and
the session-orchestration layer above it are both published packages, and this app is the
domain-specific glue and UI on top of them.

```
@tinytars/vault      crypto, auth-client, auth-recovery, key-store, envelope-access, D1EnvelopeStore
   |
   v
@tinytars/frame      session/auth controllers + screens (see packages/frame/ARCHITECTURE.md)
   |
   v
apps/lexitar
   Svelte UI (src/lib)          the Finding DAG, chat, markers, treatment, ingest, patient-record tabs
   Pages Functions (functions/) app-specific glue: routing, policy, D1 schema, audit
   ingest CLI (scripts/)        the deterministic side of turning a lab file into vault content
```

## The vault boundary, precisely stated

Encryption and decryption happen only in the browser and in the local CLI. `functions/` — the
Cloudflare Pages backend — never decrypts in the request path and never sees a password, KEK, or
DEK; it moves sealed HD1 blobs (the vault) and, separately, plaintext raw file bytes for source
documents that are stored unencrypted by design. The mechanism is `@tinytars/vault`'s: a per-vault
DEK encrypts the record, and the DEK is wrapped once per authorized principal via ECDH-ES — see
`@tinytars/vault`'s own `ARCHITECTURE.md` for the byte layout and the full principal model (owner /
org-recovery / grantee) that this app's `functions/_lib/identity-vault.ts` composes against.

The one thing worth stating exactly, because it's easy to overclaim: **the operator cannot silently
decrypt a patient's vault, but the operator's decrypt capability is not zero — it's audited,
disclosed at signup, and revocable by the patient, not eliminated.** Every account gets an
org-recovery envelope by default, wrapped to an operational P-256 keypair kept out-of-band; a
patient can revoke it (`DELETE /api/vault/recovery-envelope`), and every use is logged to
`phi_access_events`, both server-side (grant/revoke) and CLI-side (`scripts/access-log.ts` around
every org-key decrypt). A separate, narrower support-agent access path
(`functions/api/support/approve.ts`) is consent-gated, expires, and re-keys on exit. The claim this
app makes is "no undisclosed backdoor, every privileged read logged" — not "structurally
impossible" — and the rest of the docs should never round that up.

`functions/_lib/guard.ts` is the bearer-token half of the auth surface still in use (`VAULT_TOKEN`,
for `PUT /api/vault/{id}`): a length-guarded, constant-time comparison against a comma-separated
allowlist of secret values. Everything else (`/api/chat`, `/api/raw`) has moved to session-cookie
auth (`hd_session`, HMAC-SHA256). `functions/_lib/step-up.ts` requires re-proving a current
password before a new passkey or Google identity can be added to an account — closing the gap
where a stolen session cookie could otherwise mint a permanent new credential — and where there's
no password to challenge, the action proceeds but always emails a notification, which the code
treats as the residual control, not a courtesy.

## Ingest CLI (`scripts/`)

One shared pipeline for every marker source, run via `npm run ingest -- --client <id> ...`:

```
lab file → detect by extension → per-source parser → MarkerResult[] → dedup merge → vault.json → .enc
```

Parsers are routed by file extension alone, never by content-sniffing (`src/lib/parsers/`):
`.xlsx`/`.xls` goes to a blood-lab or scale/body-composition parser depending on sheet shape;
`.pdf` goes to a DEXA parser that reads fixed `(x,y)` table coordinates via `pdfjs-dist` —
deliberately brittle to template changes, not disguised as robust. A separate LLM-based path
handles narrative radiology PDFs; it's a different code path from this deterministic
extension-routing, not a fallback inside it.

Every parser emits the same `MarkerResult { marker, group, source, date, value, unit, ref? }`
shape, with units canonicalized at parse time so a value from one lab is comparable to another's.
Every source file is content-hashed to a `sourceId`; raw bytes and a pre-fold extraction artifact
are kept alongside the vault under a matching, self-describing filename, and every derived reading
carries that `sourceId` back to its origin. Removing a source is a real operation
(`src/lib/report-merge.ts`'s `removeSource()`), not a soft flag: it drops what only that source
contributed, re-attributes what a surviving source also supplies, and leaves a PHI-free tombstone
behind — `vault:verify` enforces that no reading or tombstone ever points at a dropped source.

## Svelte UI (`src/lib`)

Organized around one central derived-reasoning graph, not a flat page-per-feature layout:

- **The Finding DAG** (`finding-dag.ts`, the largest hand-written file in the app) is the
  AI-generated reasoning layer: a node graph with its own staleness tracking
  (`staleness.ts`/`stale-guard.ts`, driven by an inputs-hash scheme) and a generic
  "regenerate one derived leaf via the model" engine (`leaf-regen-registry.ts` and friends) that
  markers, ranges, treatment reasoning, and marker-groups all ride on rather than each shipping
  their own regeneration logic.
- **Sidebar** (`Sidebar.svelte`, the largest Svelte file in the app) is a dispatch table over
  roughly eight content domains — markers, exploration, hypotheses, glossary, questions, reports,
  treatment, recommended-markers — each with its own `*-sidebar-groups.ts` module rather than one
  shared branch of conditionals.
- **Chat** is an in-app assistant layer (`chat-store.ts`, `chat-tools.ts`, `ChatTab.svelte`) with
  its own thread/turn model, separate from the Finding DAG's own regeneration calls to the model.
- **Markers/ranges** (`MarkersTab.svelte`, `MarkerChart.svelte`) is the quantitative view over
  ingest output — charts, per-marker detail, reference-range eligibility and generation.
- **Treatment** (`UnifiedTreatment.svelte`, the single largest file in the app) reasons over
  medications: inference, name-matching, dosage, and fanout across the marker/finding graph.
- **Ingest UI** (`ImportTab.svelte`) is the browser-side counterpart to the CLI pipeline above —
  the same extraction/attachment model, reachable without a terminal.
- **Patient-record tabs** (allergies, family history, notes, study/imaging, personalization) are
  each a self-contained model-plus-view pair, not a shared generic-record component — the domains
  differ enough that a shared abstraction would cost more than the duplication it removes.
- **Export/sharing** (`export.ts`, `permalink.ts`) and app chrome (`brand.ts`, disclaimers,
  about/footer) round out the layer.

None of this reads or writes vault content through local crypto — it goes through
`@tinytars/vault`'s exported functions (`crypto`, `vault-sink`, `auth-client`, `key-store`, and the
rest), imported as a real npm dependency, the same way `functions/_lib/identity-vault.ts` does on
the server.

## Pages Functions backend (`functions/`)

A REST-ish set of Cloudflare Pages Functions grouped by concern: account/session/credential
management (`identity-accounts.ts`, `identity-credentials.ts`, `webauthn.ts`, `google.ts`,
`session.ts`, `recovery.ts`, `erasure.ts`), vault/envelope movement (`identity-vault.ts`,
`vault-principals.ts`, `store.ts`, `raw-owner.ts`), audit (`audit.ts`, `identity-audit.ts`,
`log.ts`), and AI-backed endpoints (`chat.ts`, `refresh-finding.ts`, `refresh-range.ts`,
`refresh-marker-groups.ts`, `leaf-regen.ts`, `treatment-infer.ts`, `extract.ts`,
`document-extract.ts`) that call out to the configured model provider but never touch a vault key. All of it composes
`@tinytars/vault`'s `D1EnvelopeStore` and `resolveEnvelopeAccess` rather than reimplementing
envelope CRUD or access resolution locally — `identity-vault.ts` is a thin re-export shim over the
package for exactly that reason, keeping every existing import site unchanged while the actual
logic lives upstream. The one function that stays local, `getEnvelope()`, composes the package's
generic access resolver with this app's own policy: its `ORG_ACCOUNT_ID` and its provider-link
rules.

D1 (`health-identity-{dev,prod}`, two physically separate databases, not one shared database with a
prefix) holds accounts, credentials, identities, public keys, vault envelopes, provider links, and
the `phi_access_events` audit log; R2 holds only ciphertext. Both are environment-isolated, not
just namespace-isolated, so a dev-environment bug cannot reach production data through a shared
store.

### Cloudflare is one host, not a dependency

Production runs on Cloudflare Pages, but nothing in `functions/` or `src/` imports a Cloudflare
module — `tests/unit/platform-imports.test.ts` fails if one does. A route sees only its Pages-shaped
context (`request`, `env`, `params`, `waitUntil`) and two storage ports: `env.DB`, `@tinytars/vault`'s
structural `D1Database` (SQL is plain SQLite, so `migrations/` run anywhere SQLite does), and
`env.VAULT`, the `ObjectBucket` blob port in `functions/_lib/object-bucket.ts`.

`apps/lexitar/server/` is a second host that proves it: `node:http` serving the same `dist/` and the
same `functions/` tree — Pages' file-based routing and `_headers` reproduced — over `node:sqlite`
(`sqlite-d1.ts`) and a directory of blobs (`fs-bucket.ts`). Conformance suites
(`tests/unit/{d1,object-bucket}-conformance.test.ts`) run one set of cases against real workerd D1/R2
and the Node adapters, and CI runs the unit and e2e suites on both hosts. The Node host is a
portability proof, not a second production: no TLS, backups, or secret management beyond
`process.env`. Ops tooling (`wrangler.sh`, `d1-migrate.sh`, `r2-ops`, snapshots) stays
Cloudflare-specific.

### Anthropic is one model provider, not a dependency

The model gets the same treatment. Every call core takes an injected `MessagesClient`
(`@pablotech/akesi/model-client`), the subset of Anthropic's Messages API they use (`create` and
`stream`), and nothing constructs a client except `functions/_lib/inference/resolve.ts`'s
`modelFor(env, feature)`. That resolver reads `apps/lexitar/inference.config.json`, the one file
naming each feature's provider, model and key env var. It returns either the Anthropic SDK or
`inference/openai.ts`, an adapter that speaks the same port over any OpenAI-compatible
`/chat/completions` endpoint (OpenAI, Ollama, vLLM, LM Studio). The adapter refuses input a model's
declared `caps` can't take before sending anything. `tests/unit/model-ids-single-source.test.ts`
fails if a source file names a model id outside the config. Setup: `apps/lexitar/INFERENCE.md`.

## Two things worth reading before you adapt this

**The server never holds a key, but it does hold policy.** `functions/` decides *who* may read a
given envelope (owner / org-recovery / provider link — `@tinytars/vault`'s three-principal model)
and logs every privileged read — it does not, and structurally cannot, decrypt on anyone's behalf
without their own key material. Conflating "the server enforces access" with "the server can read
the data" is the single most common misreading of this design; they are different properties, and
only the first one is true of `functions/`.

**The Finding DAG's staleness model is what keeps AI-generated content from silently going stale.**
A new field added to `client.factors`, a new marker, or a new source doesn't retroactively update a
treatment conclusion or a Finding on its own — `factors-hash.ts`/`node-input-hash.ts` compute a
hash of what a derived node actually depended on, and a mismatch is what `stale-guard.ts` surfaces
as "this needs regeneration," not a background job silently rewriting content. A change that adds a
new input to an existing derivation without updating its hash inputs will produce content that
looks current but was computed from stale inputs — worth checking deliberately, never assumed safe
by default.

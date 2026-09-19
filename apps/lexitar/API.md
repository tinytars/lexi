# LexiTar — HTTP API

The dashboard is a static Cloudflare Pages SPA, but it carries a small server-side API
implemented as **Cloudflare Pages Functions** under `functions/`. Each file maps to a route on
the same Pages deployment (no separate Worker, no separate domain). Live endpoints:
**`POST /api/chat`**, **`GET|PUT /api/vault/{id}`** (R2-backed), and
**`GET /api/raw/{id}/{file}`** (session-gated raw-original download).

- Runtime: Cloudflare Workers (V8 isolate), `nodejs_compat` enabled (`wrangler.jsonc`).
- Source: `functions/api/chat.ts`, `functions/api/vault/[id].ts`, `functions/api/raw/[[path]].ts`
  (routes) and `functions/_lib/guard.ts` (bearer guard) / `functions/_lib/log.ts` (PHI-free logging)
  / `functions/_lib/store.ts` (`storeKey` — every R2 key is namespaced by `env.STORE_PREFIX`).
- Secrets live in the Function env binding (`ANTHROPIC_API_KEY`, `VAULT_TOKEN`,
  `PROVIDER_TOKEN`) + the per-environment `STORE_PREFIX` var + the R2 `VAULT` binding — never in the bundle.
- Architecture context for the vault flow: **`VAULT.md`**; ops/secrets: **`AUTH.md`**.

## Base URLs

| Environment | URL | Notes |
|---|---|---|
| Local | `http://localhost:8788` | `npm run dev:functions` (build + `wrangler pages dev dist`). Plain `npm run dev` / `vite` does **not** run Functions. |
| Production | `https://health-dash-aex.pages.dev` | Cloudflare Pages **project** `health-dash-dev` (the `.pages.dev` domain carries an auto suffix); deploys on git push. Fronted by Cloudflare Access (email-match). |

## Authentication

All API routes require a bearer token:

```
Authorization: Bearer <token>
```

The token is **`base64url(SHA-256(<passphrase>))`** — derived in the browser from the
per-client vault passphrase (which equals the client id — opaque since G1, not a name). The raw
passphrase is never sent; only its hash. Derivation lives in
`src/lib/crypto.ts → deriveBearerToken` and is reused server-side to build the allowlist, so
the two can never desync (pinned by `tests/unit/derive-token.test.ts`).

Server-side, each gating secret (`VAULT_TOKEN`, `PROVIDER_TOKEN`) is a **comma-separated
allowlist** of those hashes (one per patient). A request is authorized if its bearer matches **any**
entry, compared in constant time (`functions/_lib/guard.ts → requireBearer`). The three are distinct
secrets but hold the same value today. Generate the allowlist with:

```
npm run allowlist        # base64url(sha256(id)) for each records/public/data-<id>.enc, comma-joined
```

Properties:
- No shared secret ships in the public bundle — only the hashing code does.
- Access is gated to exactly whoever can already unlock a vault.
- **PoC-grade.** A single shared allowlist, not per-request signed/scoped tokens. Cloudflare
  Access provides an additional perimeter; the bearer keeps the endpoint from being an open
  relay even inside that perimeter.

Failure → `401` with `{"error":"unauthorized"}` (missing header, malformed `Bearer …`, or no
allowlist match).

---

## `POST /api/chat`

Answer a free-text question about one patient, grounded in a context block the caller
supplies. The Function holds no patient data — the browser assembles and sends the context.

### Request

**Headers**

| Header | Required | Value |
|---|---|---|
| `Authorization` | yes | `Bearer <derived-token>` (see Authentication) |
| `Content-Type` | yes | `application/json` |

**Body**

```jsonc
{
  "question":   "what changed since my last echo?", // required, non-empty string
  "context":    { /* ChatContext — see below */ },   // optional; omit/empty = no record to reason over
  "history":    [ { "role": "user"|"assistant", "text": "…" } ], // optional prior turns (multi-turn)
  "unitSystem": "imperial" | "metric"                // optional; default imperial (US). See note below.
}
```

`context` is an opaque JSON value to the Function — serialized into the prompt verbatim. The browser
builds it with `src/lib/chat-context.ts → buildChatContext(client, unitSystem)`; an empty/absent
context yields a "no data provided" answer (by design, not an error).

**Units:** the browser **pre-converts** every reading/delta in `context` to the chosen
`unitSystem` (US-conventional or SI) so chat numbers match the grid; the Function adds one
system-prompt line naming the active system. The model does no unit arithmetic. Default is `imperial`
(US), matching the app's default selector.

#### `ChatContext` shape (what the browser sends)

Defined in `src/lib/chat-context.ts`. A compact slice of the decrypted `Client` — not the
whole vault.

```ts
interface ChatContext {
  patient: { name: string; age: number | null; gender: string };
  diseases: { diagnostic: string; icdCodes?: string[]; summary?: string }[];
  medications: { drug: string; dose: string; since: string }[];   // collapsed: 1 row/drug, earliest start + latest dose
  supplements: { drug: string; dose: string; since: string }[];
  watchlist: string[];
  readings: {                                                      // COMPLETE per-marker history
    marker: string;
    rows: { date: string; value: number; unit: string; valueText?: string }[]; // converted to unitSystem
  }[];
  deltas: {                                                        // from src/lib/marker-deltas.ts
    marker: string;
    unit: string;
    latest: { value: number; date: string };
    vsPrior: { abs: number; pct: number | null; direction: "up"|"down"|"flat"; spanDays: number };
    vsBaseline?: { abs: number; pct: number | null; direction: "up"|"down"|"flat"; spanDays: number };
  }[];
  finding?: {                                                      // the synthesized Finding slices, when present
    progression?: { latest: string; recent: string; overall: string };
    clinicalSynthesis?: { adverse: string; favorable: string; conditioning?: string };
    criticalRatios?: { name: string; meaning: string }[];
  };
}
```

### Response

**`200 OK`**

```json
{ "answer": "…plain-prose answer…" }
```

| Field | Type | Notes |
|---|---|---|
| `answer` | string | The model's reply, concatenated from its text blocks. Plain prose — the system prompt forbids Markdown so the UI needs no renderer. |

**Errors**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error":"malformed JSON body"}` | Request body is not valid JSON. |
| `400` | `{"error":"question is required"}` | `question` missing, not a string, or empty/whitespace. |
| `401` | `{"error":"unauthorized"}` | Missing/invalid bearer (see Authentication). |
| `405` | — | Method other than `POST` (only `onRequestPost` is defined). |
| `502` | `{"error":"chat backend error"}` | The upstream Anthropic call threw. Generic by design — no internals leak. |

### Model & behavior

- Model: **`claude-sonnet-4-6`** (the cheap tier — chat is follow-on Q&A, not the Opus PROD
  Finding). Defined as a local constant in `functions/api/chat.ts`, cross-referenced to
  `scripts/inference-config.ts`. Changing it is a deliberate, recorded decision.
- Non-streaming, `max_tokens: 4096`, no extended thinking.
- System prompt: a **read-only** assistant over the supplied context; it does not diagnose and
  frames uncertain points as questions for the care team. It is passed today's date and is
  forbidden from attributing a marker change to a treatment whose start date is after the
  reading — the same date-awareness discipline as the Finding.

### Examples

Grounded answer (context populated):

```bash
curl -s -X POST "$BASE/api/chat" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(printf '%s' "$CLIENT_ID" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')" \
  -d '{
    "question":"what changed since my last echo?",
    "context":{
      "patient":{"name":"Alex","age":46,"gender":"male"},
      "deltas":[{"marker":"Aortic valve mean gradient","unit":"mmHg",
                 "latest":{"value":14,"date":"2026-06-15"},
                 "vsBaseline":{"abs":4,"pct":40,"direction":"up","spanDays":1826}}]
    }
  }'
# → 200 {"answer":"…the gradient rose 4 mmHg (~40%) over ~5 years…"}
```

Auth failure:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/chat" \
  -H 'content-type: application/json' -d '{"question":"hi","context":{}}'
# → 401
```

---

## Configuration & secrets

| Name | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Pages secret (prod) / `.dev.vars` (local) | Key the Function uses to call Anthropic. **Must be distinct** from the CLI pipeline's key so chat usage can't exhaust the Finding's credits. |
| `CHAT_TOKEN` | — | **Deleted 2026-08-26.** `/api/chat` is session-gated (`requireSession`); no Function read this. |
| `VAULT_TOKEN` | Pages secret (prod) / `.dev.vars` (local) | Same allowlist value — gates `PUT /api/vault/{id}`. |
| `RAW_TOKEN` | — | **Deleted 2026-08-26.** `/api/raw` is gated by `hd_session` plus a per-record `rawAccessFor` check; this Function never read a bearer. |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | Pages secrets / `.dev.vars` (local) | W84 — `/api/speak`'s Azure AI Speech key and region (`eastus`, resource group `lexitar-speech`). Unset, read-aloud uses the browser voice. |
| `STORE_PREFIX` | Pages **var** (committed per-branch in `wrangler.jsonc`) | R2 key namespace per deployment (dev branch = `dev`). Not a secret. **Interim:** the adopted target is physically separate per-env buckets (`health-vault-dev`/`-prod`), retiring this var — see `VAULT.md` §8. |

`.dev.vars` is gitignored and used only by `wrangler pages dev`. Production secrets are set
out of band (full runbook: **`AUTH.md`**):

```bash
# from apps/lexitar/
wrangler pages secret put ANTHROPIC_API_KEY   # paste the distinct key
wrangler pages secret put VAULT_TOKEN         # same allowlist value
```

Re-run `npm run allowlist` and re-set the three token secrets whenever a client slice
(`records/public/data-<id>.enc`) is added. Full runbook: `AUTH.md`.

## Local development

```bash
npm run dev:functions     # build + wrangler pages dev dist  → http://localhost:8788
```

`vite dev` serves the SPA but **not** `functions/`, so calls to `/api/*` 404 there — always
use `dev:functions` (or the deployed site) to exercise the API. The panel surfaces a failed
call as an inline error.

## Security model

- The encryption boundary stays in the browser (PBKDF2 + AES-GCM); the Function never sees the
  passphrase or decrypts anything.
- The question + context **are** sent to the Function and on to Anthropic — consistent with the
  existing pipeline, which already sends full vault context to Anthropic for the Finding. The
  new exposure is the public endpoint, closed (PoC-grade) by the bearer allowlist and the
  Cloudflare Access perimeter.
- No secret appears in the deployed bundle; `ANTHROPIC_API_KEY` lives only in the Function env.
- W84 — read-aloud text goes to Azure AI Speech (`/api/speak`), under Microsoft's HIPAA BAA.

## Logging

Each Function request emits one structured JSON line (`functions/_lib/log.ts`), visible via
the Cloudflare dashboard and `wrangler pages deployment tail`:

```json
{"at":"…","route":"/api/chat","status":200,"latencyMs":1593,"requestId":"<cf-ray>","usage":{"input":169,"output":5}}
```

It records request **shape and outcome only** — status, latency, Anthropic token counts, and a
short `errorCode` on failures. **Never** the `question`, `context`, `answer`, vault bytes,
passphrase, or bearer (all PHI/secret). Retention, alerting, and a vault-write audit trail remain
an observability follow-up.

## Verifiability — every behavior is provable headlessly

**Standing rule:** nothing merges that can only be checked by clicking the UI. Each layer is
proven by its native headless tool, and new features ship with the matching coverage:

| Layer | Prove it with | Examples |
|---|---|---|
| **API / server** (`functions/`) | a vitest test importing the handler + a `curl` contract | `chat-function.test.ts` (mocked Anthropic SDK — guard/validation/success/error-mapping/PHI-free log + the unit-system prompt line); `vault-function.test.ts` (GET/PUT, store-prefixed key, self-seed); `raw-function.test.ts` (401/400/404/200, lowercase id, PHI-free log); `store.test.ts` (`storeKey` throws on empty prefix). No live billable call. |
| **UI behaviour** | Playwright (headless) | `tests/e2e/chat.spec.ts` (route-stubbed `/api/chat`: answer + the billing link), `view-controls.spec.ts` (mode/filter/unit/window + delta indicator), `editor-roundtrip.spec.ts` (save→reload→persisted + unlock error states). |
| **Pure logic** (`src/lib`) | vitest unit test | `marker-deltas`, `ranges`, `status`, `units`, `staleness`, `crypto`, … |

Notes for authors:
- e2e runs against `vite dev`, which does **not** run Functions — stub `/api/chat` (and any
  future server route) with Playwright `page.route`; never make a live Anthropic call in a test.
- e2e that would otherwise persist must intercept the save endpoint (`page.route("**/__save-vault*")`)
  and replay the blob — a test must never write `records/public/data-*.enc` on disk (see
  `editor-roundtrip.spec.ts`).
- Manual API spot-check: `npm run dev:functions` (builds + `wrangler pages dev dist`), then
  `curl` per the §Examples above. Automated coverage is the vitest Function test.
- Run `npm run test:all` (unit + e2e) before every commit; surface both pass counts.

---

## `GET|PUT /api/vault/[id]` (R2 sink)

Remote/mobile vault persistence (`functions/api/vault/[id].ts`). The Function only ever moves an
**already-encrypted HD1 blob** — it never decrypts, derives a key, or sees the passphrase. The
R2 object key is **store-prefixed**: `{STORE_PREFIX}/data-{id}.enc` (`id` = lowercase client slug),
via `functions/_lib/store.ts → storeKey`. The static-asset self-seed source stays unprefixed
(`data-{id}.enc`, per-branch already).

- **`PUT`** (write) — **guarded** by `VAULT_TOKEN` (`functions/_lib/guard.ts`), a **distinct**
  secret, generated by `npm run allowlist`. The client sends a passphrase-derived bearer
  (`deriveBearerToken`). Body must begin with the `HD1` magic (else `400`), be ≥ 32 bytes
  (else `400`) and ≤ 5 MB (else `413`); on success `204`. Every write emits a PHI-free **audit**
  log line: `{route:"/api/vault", status:204, id, bytes}` — id + size only, **never** the
  blob bytes.
- **`GET`** (read) — **the ops bearer (`VAULT_TOKEN`) OR a session holding an envelope for this
  vault** (§G). Note this gate is not a confidentiality boundary: the identical bytes stay
  world-readable at the static `public/data-{id}.enc` by design (`VAULT.md` §Plaintext at rest),
  so what an authenticated read buys is audit and write-path hygiene, not secrecy. Reads from R2; on a miss it
  **self-seeds** from the static asset via `env.ASSETS` and lazily writes it back to R2, so
  explicit seeding is optional. `404` if neither R2 nor a static asset has it.

```bash
# write (PUT) — 204
curl -X PUT "https://<domain>/api/vault/<client-id>" \
  -H "authorization: Bearer <deriveBearerToken(passphrase)>" \
  -H "content-type: application/octet-stream" --data-binary @records/public/data-<client-id>.enc
# → 204 ;  no/bad bearer → 401 ;  non-HD1 body → 400 ;  > 5 MB → 413

# read (GET) — 200, returns the encrypted blob (self-seeds R2 on first miss)
curl "https://<domain>/api/vault/<client-id>" -H "authorization: Bearer <VAULT_TOKEN>" -o /tmp/data-<client-id>.enc
# → 200 ;  no bearer and no session → 401 ;  session without an envelope → 403 ;  unknown id → 404
```

Auth coarseness (accepted): `VAULT_TOKEN`'s value equals the chat allowlist today; they are kept
as separate secrets so they rotate independently. Finer per-vault binding
(`HMAC(serverSecret, id)`) is a deferred option. Local test: `wrangler pages dev dist --r2 VAULT`
with `VAULT_TOKEN` in `.dev.vars`; automated coverage in `tests/unit/vault-function.test.ts`.

---

## `GET /api/vault/org-key` (org-recovery public key)

Serves the org-recovery public key (`functions/api/vault/org-key.ts`). **Unauthenticated by
design** — signup calls it before a session exists, and a public key carries no confidentiality
requirement, so there is nothing to gate it with anyway.

- **`GET`** → `200 { orgAccountId, orgPublicKeyJwk }`; `500 {"error":"missing org public key"}`
  (`errorCode: missing_org_key`) if the org account has no public-key row.

```bash
curl -s https://<domain>/api/vault/org-key
# → 200 {"orgAccountId":"00000000-0000-4000-8000-000000000001","orgPublicKeyJwk":{...}}
```

Consumed by `src/lib/auth-client.ts → getOrgKey()`, called from `signupPassword`/`signupPasskey`
to build the `orgEnvelope` both signup bodies now require (see below).

---

## `POST` / `DELETE /api/vault/recovery-envelope` (mint / revoke org recovery)

Mints or revokes the org-recovery envelope for the caller's own vault
(`functions/api/vault/recovery-envelope.ts`). Session-gated (`requireSession`), scoped to the
vault `listVaultsForOwner` returns for that session.

- **`POST`** — body `{ wrappedDEK: base64, ephemeralPublicKeyJwk }`. `400` if either is missing;
  `404 {"error":"no vault"}` if the session owns no vault; `409 {"error":"org recovery revoked"}`
  if the patient already revoked it; `200 {"status":"exists"}` if the envelope is already present
  (idempotent); else writes it and records `phi_access_events.action = "org_recovery_minted"` →
  `201 {"status":"created"}`.
- **`DELETE`** — `404` as above; else deletes the envelope, sets `vaults.org_recovery_revoked_at`,
  records `action = "org_recovery_revoked"` → `200 {"status":"revoked", "revokedAt"}`. Idempotent
  — revoking again returns the original `revokedAt`.

```bash
curl -X POST https://<domain>/api/vault/recovery-envelope \
  -H "cookie: hd_session=<session>" -H "content-type: application/json" \
  -d '{"wrappedDEK":"<b64>","ephemeralPublicKeyJwk":{...}}'
# → 201 {"status":"created"}

curl -X DELETE https://<domain>/api/vault/recovery-envelope -H "cookie: hd_session=<session>"
# → 200 {"status":"revoked","revokedAt":"2026-08-09T..."}
```

Called from `src/App.svelte` — `ensureOrgRecoveryEnvelope()` (POST, best-effort backfill after
unlock; never blocks or fails it) and `doRevokeRecoveryKey()` (DELETE, Account modal's "Recovery
key" block).

---

## `GET /api/account/access-events` (patient-visible access log)

The patient-visible read of `phi_access_events` (`functions/api/account/access-events.ts`) — the
first caller of `listAccessEventsForSubject`. Session-gated.

- **`GET`** → `200 { events: AccessEventRow[] }`, newest first, capped at 200:
  ```ts
  interface AccessEventRow {
    id: string; action: string; actorAccountId: string;
    vaultId: string | null; consentRef: string | null; meta: unknown; createdAt: string;
  }
  ```

```bash
curl https://<domain>/api/account/access-events -H "cookie: hd_session=<session>"
# → 200 {"events":[{"id":"...","action":"org_key_decrypt","actorAccountId":"0000...0001", ...}]}
```

Rendered in the Account modal's "Recovery key" block (`src/App.svelte`).

### Related — new fields on existing (undocumented) routes

Not otherwise covered by this file, but touched by the org-recovery work above:

- `GET /api/vault/principals` response gains `envelopePrincipalIds: string[]` (principal ids
  holding an envelope for the caller's vault) and `orgRecoveryRevokedAt: string | null`.
- `POST /api/auth/password/signup` and `POST /api/auth/passkey/register/verify` request bodies
  gain a required `orgEnvelope: { wrappedDEK, ephemeralPublicKeyJwk }`, mirroring `ownerEnvelope`
  — signup now writes two envelopes, not one.

---

## `POST /api/persona-adapt` (W84 — Kodi's retelling)

Session-gated. Body `{ persona: "kodi", text }`: `text` is Lexi's finished answer, restated by the
adapter prompt (`src/lib/persona-adapter-prompt.ts`) on `PERSONA_ADAPTER_MODEL`. A deterministic
fidelity gate requires every number, unit and date from `text` in the output, retrying once; if it
still fails the response is `{ kind: "fallback" }` and the client keeps Lexi's words, labeled Lexi.
The adapter never sees the record, only the answer.

```bash
# → 200 {"kind":"adapted","persona":"kodi","text":"…"} | {"kind":"fallback"} ;  no session → 401
#   unknown persona / empty text → 400 ;  text too long → 413
```

---

## `POST /api/speak` (W84 — neural read-aloud)

Session-gated. Body `{ voice?: "lexi" | "kodi", text }` (≤ 2000 chars; the client sends one chunk at a
time). Relays SSML to **Azure AI Speech** (`AZURE_SPEECH_REGION`, the persona's fixed neural voice) and
streams back `audio/mpeg`, `Cache-Control: no-store`. Nothing is stored or logged beyond shape and
status. The text is answer text, i.e. PHI, so Azure AI Speech is a processor: it is covered by
Microsoft's HIPAA BAA (Product Terms, in-scope service). When the relay fails the browser falls back
to its own OS voice, which never leaves the device.

```bash
# → 200 audio/mpeg ;  no session → 401 ;  bad voice / empty text → 400 ;  > 2000 chars → 413
#   secrets unset → 503 ;  Azure non-OK → 502
```

---

## `POST /api/client-error` (browser error reporting)

`src/lib/error-reporter.ts` posts every uncaught error and unhandled rejection here (each distinct
error once per page load, at most 5). Session-gated (`hd_session`). The body `{ name, message, stack, build }`
is PHI-scrubbed server-side (`functions/_lib/client-error.ts`), then filed in
`CLIENT_ERROR_GITHUB_REPO` (`pablo-tech/plover-factory`, private): a new issue titled
`Client error: <name> [<fingerprint>]` — the scrubbed message goes in the body only — or a comment on
the open issue carrying the same fingerprint. `build` is the deploy's commit SHA
(`CF_PAGES_COMMIT_SHA`, baked in at build time), linked from the issue body. Each issue carries a `fp:<fingerprint>` label, which is how a
recurrence finds it (`/search/issues` lagged new issues by over a minute; the label filter by ~4s). The
fingerprint hashes name + scrubbed message, so the same crash on a later deploy lands on the same issue. Without
`CLIENT_ERROR_GITHUB_TOKEN`/`_REPO` the report is only `console.error`ed.

```bash
# → 204 always once authenticated (a GitHub failure is logged, never surfaced) ;  no session → 401
#   malformed JSON → 400 ;  body > 16 KB → 413
```

---

## `GET` / `DELETE /api/raw/[[path]]` (raw-original download + delete)

Stream an **original imported file** (PDF/XLSX) for the Export tab's "Imported files" section
(`functions/api/raw/[[path]].ts`). Raw originals are **plaintext PHI**. The Function never decrypts:
raw is stored **unencrypted** in R2 under `{STORE_PREFIX}/raw/{id}/{file}`. The id is **lowercased**
server-side — a no-op since G1 made client keys the lowercased account id, kept because a vault
predating G1 can still carry a display-cased key.

> **Corrected — this section described a gate the code does not have.** It said the route is
> bearer-gated by `RAW_TOKEN`. It is **session**-gated (`requireSession`): `RAW_TOKEN` is
> not read by this Function and is not in its `Env`. A doc that names a stronger gate than the code
> implements is worse than no doc, because it is what a reviewer checks instead of the code.
>
> **Known gap, not yet fixed.** The route is authenticated but **not authorised**: `id`
> is the vault's client key — a human display name — and is never compared against anything the
> session owns. Any signed-up account can therefore read, overwrite or delete another patient's
> plaintext originals, two accounts with a client of the same name share one namespace, and revoking
> a clinician's vault envelope does not stop them reading the raw PDFs. `/api/document-extract` has
> the identical shape and returns extracted plaintext. Neither writes to `phi_access_events`, so the
> access is invisible to the patient's access-events screen and to any breach-scoping exercise.
>
> Closing it means re-keying the namespace by `vaultId` rather than display name — the server cannot
> resolve a display name to an owner, because client keys exist only inside the encrypted vault — and
> migrating the existing R2 objects. That is a deliberate operation on the only authoritative copy of
> patient data, so it is scoped as its own piece of work rather than folded in here.

- **`GET /api/raw/{id}/{file}`** (`hd_session` cookie): `env.VAULT.get(storeKey(env,"raw",id,file))` →
  stream bytes with a content-type by extension (`pdf`/`xlsx`/`xls`/`json`, else octet-stream),
  `cache-control: no-store`. `400` on a missing segment or path traversal (`.`/`..`); `404` on a miss.
  PHI-free log `{route:"/api/raw", status, id}` — id + outcome, never the filename or bytes.
- **`DELETE /api/raw/{id}/{file}`** (`hd_session` cookie): `env.VAULT.delete(storeKey(env,"raw",id,file))`
  → `200 {deleted:true}`. Same path/guard rules (`400`/`401`). **Idempotent** — deleting an absent object
  still `200`s. This is the web-delete shape: the browser runs the pure `removeSource()`,
  `PUT`s the re-encrypted vault, then `DELETE`s the raw object. (The CLI `--remove-source` does the
  equivalent server-side today, incl. deleting the processed artifact.)

```bash
# 200 — streams the original PDF (bearer = deriveBearerToken(passphrase))
curl "https://<domain>/api/raw/<client-id>/2020March04-imaging-echo-0a1b2c3d.pdf" \
  -H "authorization: Bearer <token>" -o /tmp/echo.pdf
# no/bad bearer → 401 ;  /api/raw/<client-id> (no file) → 400 ;  unknown file → 404

# 200 {"deleted":true} — expunge one raw object from R2 (idempotent)
curl -X DELETE "https://<domain>/api/raw/<client-id>/2020March04-imaging-echo-0a1b2c3d.pdf" \
  -H "authorization: Bearer <token>"
```

In dev, `vite` doesn't run Functions — a dev-only middleware (`vite.config.ts → rawFileMiddleware`)
mirrors this route from `records/private/{id}/raw/` (no bearer locally). Automated coverage:
`tests/unit/raw-function.test.ts` (401/400/404/200 + lowercase id + PHI-free log) and the Export e2e
in `tests/e2e/shell-nav.spec.ts`.

### Log retention (Logpush → R2, ops follow-up, not yet enabled)

Cloudflare keeps the structured request/audit lines (above) only for a short default window. To
retain them owner-only and queryable, enable **Cloudflare Logpush → the `health-vault` R2 bucket**
(or a dedicated `health-logs` bucket) with a retention window — no third-party SaaS for a
single-owner deployment. This is a dashboard/account action that needs the R2 bucket to exist
first; enable it once the vault R2 bucket is created (see `AUTH.md`).

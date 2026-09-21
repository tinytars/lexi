# The report corpus — what the model sees when it answers

Every inference about a person is made in sight of that person's own source documents: the
original PDFs, whole and unaltered, attached to the front of the request. Not a summary of them,
not the structured extraction taken from them at import — the documents themselves.

This is the difference between "ask about anything in any report" being true and being
approximately true. A structured extraction answers the questions its schema anticipated. A
radiologist's aside, a table row nothing models, a unit printed in a footnote, a comment in a
margin — none of them survive it, and a model reading only the extraction cannot tell that they
are missing. It answers confidently from a partial record. Attaching the document is the only
shape in which the question "what does my report actually say" has a truthful answer.

## 1. What every inference sees

Every PDF stored under one person's namespace, ordered by key, attached as `document` blocks
ahead of whatever the feature was going to ask. Eight features are attached in the type system; six
of them carry it on the wire today:

| Feature | Route |
|---|---|
| `chat` | `functions/api/chat.ts` |
| `leafRegen` | `functions/api/leaf-regen.ts` |
| `finding` | `functions/api/refresh-finding.ts` |
| `ranges` | `functions/api/refresh-range.ts` |
| `markerGroups` | `functions/api/refresh-marker-groups.ts` |
| `persona` | `functions/api/persona-adapt.ts` |
| `treatmentImage`, `treatmentText` | `functions/api/treatment-infer.ts` — **not yet attached**, see §6 |

Non-PDF originals (`.xlsx`, `.jpg`, `.json`) are not attached: there is no `document` block form
for them. Their readings are in the vault, extracted at import, and that remains all the model
sees of them. Stated, not solved.

## 2. Where the bytes come from

`{STORE_PREFIX}/raw/{clientId}/` in R2 — the original upload, plaintext, deliberately outside the
vault's encryption boundary (`VAULT.md`). Nothing read the objects again after import until this
feature; now every attached inference does.

**Authorisation runs inside the assembler, not in the routes.** `reportCorpus`
(`functions/_lib/inference/corpus.ts`) calls `rawAccessFor` itself before it lists anything. A
route that forgets the check cannot exist, because there is no way to obtain a corpus without
passing an `accountId` through that function. A namespace the account may not read is a **404**,
never a 403 — a 403 would confirm the namespace exists.

The corpus is discovered from R2 and D1, never from `body.client.sources[]`. Three routes take a
caller-supplied client object; deriving R2 keys from it would reintroduce exactly the class of bug
`raw-owner.ts` closed. It is also simply wrong: a `SourceRecord` can name a deleted file, and a
pending upload exists with no `SourceRecord` at all.

## 3. The request shape

`document` blocks are illegal in `system`, so the corpus is a leading user turn. Everything else
stays where it was — each feature keeps its own tools and its own system prompt:

```
tools:  [ the feature's tools, unchanged ]
system: [ the feature's system prompt, unchanged ]
messages:
  [0] user       [doc, doc, …, doc {cache_control}, CORPUS_PREAMBLE]
  [1] assistant  CORPUS_ACK
  [2…] the feature's own turns
```

Two details are load-bearing:

- **The cache breakpoint sits on the last document, not on the preamble that follows it.** The
  preamble's wording can then be edited without invalidating every patient's cached corpus.
- **The assistant ack is not decoration.** It closes the prefix on a message boundary, which stops
  the OpenAI adapter's `userParts` from concatenating corpus text and question text into one
  message — and gives the model a turn stating what the documents are for.

Documents are attached **server-side, by the route**. `chat` rejects a caller-supplied `document`
block with `400 client_document`: server ownership has to be a property, not a convention, or the
tool loop would replay ~20 MB of base64 through an 8 MB body limit on every round.

## 4. Caching

A prompt-cache entry is keyed on `(workspace key, model, exact prefix bytes)`, and the prefix
renders **`tools → system → messages`**. Every feature's tools and system prompt therefore sit
*ahead* of the corpus, so each attached feature writes its **own copy** of the same documents per
TTL window. That is the price of portability and it is paid deliberately.

The alternative was one shared entry: empty `system`, no tools, each feature's prompt moved into a
mid-conversation `system` message and its tools into `tool_addition` blocks. **Rejected** — both
are Anthropic-only and need the newest model, and `openai.ts` can express neither, which would
have made the corpus unreachable on any OpenAI-compatible endpoint. Prompt caching is an
optimization; the corpus is the feature.

### What forks an entry

Any byte ahead of the corpus. In practice:

- **The model, and the API key's workspace.** The three key pools stay separate, so they cache
  separately.
- **The date.** `chatSystemPrompt` used to interpolate `Today is …`, which killed every corpus at
  midnight. It now rides in the volatile `CONTEXT:` JSON the browser builds, *after* the corpus.
- **Chat's final round.** `withTools = body.final !== true` — the forced final round drops `tools`
  and is therefore a different prefix, and a different entry, from rounds 1…n−1. That is one extra
  write per turn that ends in a forced answer, and it is not avoidable without sending tools the
  model must not use.
- **Each leaf node.** `leaf-regen-anthropic.ts` sends a per-node tool schema and a per-node system
  prompt ahead of the corpus, so every node's corpus is a separate entry however the calls are
  ordered.

### The fan-out trap

A cache entry cannot be read until the response that writes it begins. N simultaneous first calls
with the same prefix therefore all pay a full write — N copies of one record.

`src/lib/range-fill.ts` awaits the **first** marker alone and only then fans the rest out. That
one `await` is the largest single saving in this design: on a marker sweep it turns N writes into
one write and N−1 reads.

**The leaf sweep deliberately does not do this**, and `leaf-regen-queue.svelte.ts` says so in
place. Each node forks its own entry ahead of the corpus (above), so serializing there would cost
a patient wall-clock time and save nothing.

### Pre-warming

A `max_tokens: 0` request writes the cache, returns empty content and bills no output tokens. The
write is billed either way — this moves it off the patient's cursor, it does not avoid it.
`functions/api/corpus-warm.ts` fires one when a record is opened. **Only `chat` can use it:**

| Feature | Pre-warmable | Why not |
|---|---|---|
| `chat` | **yes** | — |
| `ranges`, `markerGroups` | no | they pin their output with `output_config.format`, which `max_tokens: 0` rejects |
| `leafRegen` | no | each node forks its own entry, so warming the sweep is ~30 writes up front |
| `persona`, `treatmentText` | no | they restate text that already holds every fact |

A warm call must also match the follow-up's thinking configuration and effort, since both render
into the prefix. `max_tokens: 0` is rejected alongside `stream: true`, enabled thinking,
`output_config.format`, a forced `tool_choice` and Message Batches — so a warm call is a plain
non-streaming request, and is skipped entirely for a provider that rejects it.

**Keep-alive is capped, not indefinite** (`src/lib/corpus-warm.ts`). A read refreshes the entry's
TTL, and a read costs 0.1× base input against a write's 1.25×, so twelve refreshes (1.2×) still
come in under one write and the thirteenth would mean an idle tab quietly costing more than
re-reading the record when someone finally asks. `MAX_IDLE_KEEPALIVES = 12` is that arithmetic, not
a chosen number. A real chat turn is itself a cache read, so an active conversation refreshes the
entry on its own and no "the patient just asked" signal is wired in.

## 5. The ceiling

| Limit | Value | Where |
|---|---|---|
| Pages | `maxCorpusPages`, default **250** | per provider in `inference.config.json` — a property of the model's context window |
| Bytes | **20 MB** | `MAX_CORPUS_BYTES` — ~27.4 MB as base64, under the 32 MB request cap |
| Documents | **100** | `MAX_CORPUS_DOCS` |
| Pages per document | **60** | akesi's existing per-document bound, enforced on upload |

Pages bind before bytes. At the measured **2,239 tokens per page** (§8), the provider's own hard
limit of 600 pages is 1.34 M tokens — past a 1 M window; 250 pages is ~560 K, which leaves room for
history, context and output. A deployer pointing a feature at a 200 K-context model sets a lower
`maxCorpusPages`, which is why that one lives in config and the other two do not.

**Page counts live in D1**, in `raw_objects` (`migrations/0015_raw_object_pages.sql`), not in R2
metadata: `ObjectBucket` has no metadata channel, and widening that port would be a
Cloudflare-shaped feature in the abstraction that exists to keep this app off Cloudflare specifics.
pdf.js does not run on Workers, so the browser supplies the count it already has from rendering the
PDF, as `?pages=N` on the upload. A count can be filled in but never lowered.

Both ceilings are checked against D1 **before a byte is read from R2**: a record that cannot be
sent costs one query, not 20 MB of reads and a rejected request.

### The three refusals

| Code | Status | What it means to the person |
|---|---|---|
| `corpus_too_large` | 422 | the record holds more than one request can carry; the body names `limit`, `actual` and `max`, because the numbers are the remedy |
| `corpus_unmeasured` | 422 | some PDFs have no page count yet, so the ceiling cannot be checked; reopening the record repairs it |
| `corpus_missing` | 422 | D1 vouches for a document that is no longer in storage |
| — | 404 | the account may not read this namespace |

422, not 413: on these routes 413 already means "your request body was too big", and that is a
different remedy from "your record is too big". Every refusal carries the same sentence — *no
answer was produced, an answer from part of the record would not be trustworthy* — because that is
the decision being reported. The count of unmeasured files is sent, never their names: a file name
is PHI.

Refusals are raised **before a streaming route commits its 200**. After the headers the only
channel left is an in-band sentinel, which the browser reads as a failed generation and retries —
three full generations against a record that cannot be assembled any of the three times.

### Backfill

Every object stored before this feature has `pages IS NULL`, and the corpus refuses rather than
guess. Three things clear it, and all three ship:

1. **Refuse loudly** — `corpus_unmeasured`, naming the count.
2. **Browser self-heal** (`src/lib/raw-pages-heal.ts`) — `GET /api/raw/{id}?unmeasured=1` names the
   unmeasured keys, the app re-opens each with pdf.js and PUTs the count. One-time per file, no
   model call, no re-upload, idempotent, works on either host. This is what makes (1) self-clearing.
3. **Operator sweep** — `scripts/raw-pages-backfill.ts`, which resolves its bucket and its D1 from
   the worktree's `wrangler.jsonc`, so it runs once per environment.

Estimating pages from byte size was rejected: a 12 MB scan can be 2 pages and a 300 KB text PDF 80,
and an estimate wrong in the "it fits" direction silently sends an over-limit request — the exact
failure this design exists to prevent.

## 6. What is not attached, and why

| Feature | Why |
|---|---|
| `extract` | the browser hands it *the* document, at a moment when the bytes may not be in R2 yet; attaching the corpus would double-count it and make a new client's first import impossible against an empty namespace |
| `document` | same argument — its output *feeds* the corpus |
| `benchmarkWeakest` | no client, no R2, no session |

These three are the `UNATTACHED_FEATURES` union in `functions/_lib/inference/attach.ts`. The type
is the decision: `attachedModelFor` cannot be called for them, and `unattachedModelFor` cannot be
called for anything else.

**`treatmentImage` and `treatmentText` are attached features whose route does not yet attach.**
`inferTreatment` is published from `@pablotech/akesi`, builds its own `content` array and takes no
prefix parameter, so `functions/api/treatment-infer.ts` still resolves a bare model. It needs an
akesi release adding that parameter. This is the one place where the type says "attached" and the
wire does not, and it is a gap, not a decision.

**`documentsPromptBlock` and PDFs.** An attachment is stored under the same `raw/{clientId}/`
prefix the corpus is assembled from, so where the corpus is on the model already holds an attached
PDF as its own bytes: unlossy, laid out, quotable. Transcribing it too doubles tokens and hands the
model two versions of one document to reconcile, so `needTranscription`
(`src/lib/document-extract-client.ts`) drops it. Where `REPORTS` is `"never"` that transcription is
the only copy there is, so it is kept — which is why this is a question the browser asks rather
than a line that was deleted. It answers it from `/api/corpus-warm`'s `reason` field: `"off"` is
the one reply that means the documents are NOT in the request, and the default before any reply is
to keep transcribing. `.txt`/`.md` are always transcribed — they have no document block form — and
the `text/{id}/{key}.json` sidecar is kept unconditionally, being still the `document-extract`
cache and the cheap render path.

## 7. Turning it off

`REPORTS` in `wrangler.jsonc`'s `vars` (or the process env on the Node host, exactly like
`STORE_PREFIX`):

```jsonc
"vars": { "STORE_PREFIX": "dev", "REPORTS": "always" }   // | "never"
```

`"never"` — and unset, which means the same — restores the behaviour this app had before the
feature existed: no corpus, no PHI in a prefix nobody asked for, no change to the bill. Any other
value **throws**, rather than defaulting to off: a typo silently serving partial-knowledge answers
to every patient is the failure mode a flag like this always has.

It is deliberately **not per-feature**. A per-feature flag would let a deployer make chat
partially-informed, which is the thing this change exists to end.

It lives in `wrangler.jsonc` rather than `inference.config.json` because that file is already the
deliberately branch-divergent per-environment one, preserved across promotions by `promote.yml`'s
`keep-paths` — so dev can run `"always"` while production stays `"never"`, with no new mechanism.
`inference.config.json` keeps model, provider and capability config, and gains only
`maxCorpusPages`, which is a property of a model rather than of an environment.

**The capability contract holds either way.** A provider that cannot take PDFs gets a clean
`422 model_unsupported` — refuse, never degrade. Both shipped example stacks
(`inference.examples/`) are text-only and say in their own `$doc` that they require
`REPORTS: "never"`; a fully open, no-vendor-account deployment remains a real, documented and
tested configuration rather than a dead column in a table.

## 8. Cost

The corpus is large and is sent on every attached call, so this is a real increase, not a rounding
error. The structure of it:

- A cache **write** costs 1.25× base input; a **read** costs 0.1×; an uncached send costs 1×.
- A read **refreshes the entry's TTL**, so calls arriving inside the window keep it alive.
- Each attached feature holds its own entry (§4), so the write is paid per feature, not once.
- The first call of every window pays the write. `corpus-warm` moves chat's off the patient's
  cursor; it does not remove it.

### Measured, 2026-09-21, on dev

`npm run corpus:measure` (`scripts/corpus-measure.ts`) counts a real namespace through
`messages.count_tokens` — the whole chat prefix, tools and system included, not the documents
alone. It is free and writes nothing, so it can be re-run on any environment at any time.

| | PDFs | pages | prefix tokens | tokens/page |
|---|---|---|---|---|
| smallest namespace | 6 | 8 | 17,463 | 2,183 |
| typical namespace | 28 | 46 | 104,755 | 2,277 |
| largest namespace | 17 | 67 | 156,130 | 2,330 |
| **all four measured** | **61** | **156** | **349,318** | **2,239** |

**2,239 tokens/page**, and it is tight: the spread across four real records is 2,028–2,330, an
8% band rather than the 2× the ceiling was sized against. The 250-page ceiling is therefore
~560,000 tokens — comfortably inside a 1 M window with room for history, context and output.

### What that costs

Measured tokens at list price, from the same table `scripts/inference-cost.ts` bills against.
Per request, for the largest measured namespace:

| | cache write | cache read |
|---|---|---|
| `claude-sonnet-4-6` — chat, `leafRegen`, `persona`, `treatmentText` | $0.585 | $0.047 |
| `claude-opus-4-7` — `ranges`, `markerGroups`, `finding`, `treatmentImage` | $2.927 | $0.234 |

And per user action, on that same record:

| | serialized (shipped) | parallel fan-out (the trap §4 names) |
|---|---|---|
| Chat turn, 5 tool rounds, warm | $0.23 | — |
| Chat turn, 5 tool rounds, cold | $0.77 | — |
| Translate-all, ~30 leaf regens | **$1.94** | $17.56 |
| Marker sweep, ~120 ranges | **$30.80** | $351.29 |

The marker sweep is the number to look at before turning this on anywhere. Serializing the first
call is what makes it $31 instead of $351, and $31 is still the most expensive button in the app
by an order of magnitude — on Opus, against a record of 67 pages, well under the ceiling.

**Observed spend is not reported here, because there is none to observe**: production runs
`REPORTS: "never"` (§7), so no corpus traffic has been billed. The figures above are arithmetic
over a measured token count, not a projection of usage. Once an environment has run the corpus for
a week, the Usage and Cost Admin API is what replaces them, with the date it was taken.

Two attached features are known to earn none of it and are flagged rather than silently dropped:
`persona-adapt` restates a paragraph that already contains every fact — its own `missingFacts`
check proves it — and `treatmentText` reads a pill-bottle label. Neither touches the patient's
reports. They stay in scope; whether they stay attached is a decision for the measured numbers.

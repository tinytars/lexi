# Measurement: how model quality is scored here, and what it scored

LexiTar's prompts were written and checked against one vendor's models. [`INFERENCE.md`](INFERENCE.md)
lets a deployer point any feature at any OpenAI-compatible endpoint — which makes "it works on
Claude" an unmeasured claim about every other model the moment someone does. This page is how that
claim gets settled, and it is the **only** page in this repo that carries a number about model
quality. [`MODELS.md`](MODELS.md) says which stacks a deployer can pick;
[`INFERENCE.md`](INFERENCE.md) says how to configure one; neither repeats a result from here.

## The method

**The oracle is the app's own validator.** Every scored call runs the shipped path — the shipped
prompt builder, the shipped retry loop, the shipped `validate()` in
[`@pablotech/akesi`](https://www.npmjs.com/package/@pablotech/akesi) — and a case passes exactly
when production would have accepted the response. Never a rubric, never a second model grading the
first. A failure here is a failure a user would have seen.

**It scores feature × model, and the model set is whatever a config file names.** Measuring a new
candidate is the same edit as deploying one, because it *is* that edit: the runner takes an
`inference.config.json` and resolves each feature through the same `modelFor` the web routes use.

| Piece | Where | Owns |
|---|---|---|
| Harness | `@pablotech/akesi/benchmarks/model-portability` (pilos) | probes, retry accounting, rejection buckets, Wilson intervals |
| Runner | [`scripts/model-bench.ts`](scripts/model-bench.ts) | which config, which fixtures, how the result prints |
| Fixtures | `tests/fixtures/synthetic-*` | the documents and patients scored |

### What each run reports

Per feature × model:

- **validated / n**, with a 95% Wilson interval — the right interval at the small n a paid run affords.
- **first try** — validated on the first attempt, with no correction. This is the number that says
  whether the prompt lands on this model, as opposed to whether the retry loop can rescue it.
- **mean attempts**, censored one past the shipped ceiling for a case that never validated. Reported
  next to the pass rate, never instead of it.
- **median seconds** per case.
- **the commonest rejection**, in the validator's own words and bucketed by reason. A flat result is
  only actionable if you can see *what* the model got wrong.

`unreachable` and `unsupported` bucket ahead of every quality reason, so a model that cannot be
reached, or that refuses the input outright, is never reported as a model that answers badly.

### Which route a document takes

`extract` and `document` send a PDF one of two ways, and a row always says which:

- **native PDF** when the provider declares `caps.pdf` — the `{ pdfBase64 }` path.
- **page images** when it declares `vision` but not `pdf` — the browser renders the pages and sends
  what a human sees ([`src/lib/pdf-pages-for-model.ts`](src/lib/pdf-pages-for-model.ts)).
- **neither** is a *result*, not an error: the app refuses the feature with a 422 before any call,
  so the benchmark refuses it too rather than billing a call it knows will be rejected. The run
  records it as skipped.

## Running it

```sh
npm run bench:models -- --preview                                  # budget + pre-registration, no calls
npm run bench:models                                               # the committed default config
npm run bench:models -- --config inference.examples/open-local.json
npm run bench:models -- --feature extract,document
npm run bench:models -- --feature finding                          # minutes and dollars per case
```

`--preview` makes no call. It prints the per-feature call ceiling, the model each feature resolves
to, the route each document will take, and the pre-registration below — so the cost is known before
it is spent. Keys come from the environment exactly as they do in production
(`INFERENCE.md`); nothing here reads a key from a config file.

`finding` is never run by `--feature all`. One case is a full generation: minutes of streaming and
dollars on a frontier model, an order of magnitude more than every other feature put together. It is
measured only when named.

### Adding a candidate model

1. Add the provider to a config file — `baseUrl`, the **names** of its key env vars, and its `caps`.
   (Never a key. This repo is public.)
2. Point the features you want measured at it.
3. `npm run bench:models -- --config <that file> --preview`, then without `--preview`.
4. Paste the table into the results section below, dated, with the config file named.

### Adding a feature

1. Export a `Probe` for it from the akesi harness — the shipped call plus its cases — and release
   the patch.
2. Build it in `probesFor` in [`scripts/model-bench.ts`](scripts/model-bench.ts), from a fixture
   committed under `tests/fixtures/`.
3. Add a row to the *not measured* list below if it is deliberately left out instead.

## Fixtures

All synthetic, all committed, no PHI — this repo is public and no fixture may ever be derived from a
real patient.

| Fixture | What it is | Made by |
|---|---|---|
| `tests/fixtures/synthetic-report.pdf`, `-p1.jpg` | a one-page lab panel in SI units plus a coronary CTA impression and a dated prior comparison | [`scripts/gen-report-fixture.ts`](scripts/gen-report-fixture.ts) |
| `tests/fixtures/synthetic-note.pdf`, `-p1.jpg` | a prose clinic note over the same invented patient | same |
| akesi's twelve SI-unit ranges cases | units a model tends to answer in something else | `@pablotech/akesi/benchmarks/retry-corrections` |
| three supplement descriptions | plain, unit-bearing, and a label transcript | inline in the runner |
| `tests/fixtures/synthetic-patient.ts` | the synthetic record a Finding is generated over | the existing test fixture |

The PDF and the page image come from the same HTML, rendered by the same browser engine at the same
page box and the same width the app renders at — so the two routes differ in container, not content.
Rasterising the committed PDF instead would need a canvas Node does not have; the app's own renderer
is browser-side, and phase 2's unit tests cover it there.

## Pre-registration — recorded before the run

Committed 2026-09-20, before any result existed, per
[`pilos/CONTRIBUTING.md`](https://github.com/pablo-tech/pilos/blob/main/CONTRIBUTING.md).
`npm run bench:models -- --preview` prints this same text, so the registration cannot drift from the
thing that runs.

- **Claim under test.** `INFERENCE.md` said the prompts "were written and checked against Claude"
  and that a smaller model "may fail validation more often". That is an unmeasured claim about every
  other model.
- **Outcome.** Validated / n per feature × model, with the first-attempt rate and mean attempts
  beside it. Higher pass rate is better; lower mean attempts is better.
- **Regimes.** One run per config file. Claude as the baseline; open-weight candidates on a local
  OpenAI-compatible server (Ollama) on the hardware this repo's maintainer actually has — an NVIDIA
  **A10-4Q vGPU slice, 3.8 GiB of VRAM**. That ceiling picks the candidates: 4B-class quantised
  weights fit, and the 12B–20B models fit only by spilling into system RAM. A result here is a
  result *for models that fit 4 GiB*, and says nothing about the same architectures at larger sizes;
  those are listed as not measured rather than guessed at.
- **What each outcome will mean.** A model at or near the baseline on a feature is a usable
  alternative *for that feature* and is named in [`MODELS.md`](MODELS.md). A model that validates
  but needs more attempts is usable and slower, and is named as such. A model that fails is not recommended for
  that feature, and the rejection buckets say why. **A flat or negative result publishes unchanged**
  and the recommendation says so — that outcome is pre-registered too.
- **What would make this wrong.** n is small: single-digit for the document features. An interval
  that spans the baseline is reported as spanning it, not read as a tie. One fixture per document
  feature measures *a* report, not reports in general.

## Results

Open-weight candidates run **2026-09-20**, the `ranges` vendor baseline **2026-09-21**, both from
`npm run bench:models`. Nothing below is hand-copied from a console, and no number from this page is
repeated anywhere else in this repo or in `pilos`.

### The one-line answer

**A 4B open model, on a laptop-class GPU slice, holds the shipped contract on the structured text
features and does not hold it on the document features.** `ranges` — the app's highest-volume model
call — validated every case on the first attempt, and so did the vendor baseline when it was
finally run on 2026-09-21: **12/12 on both, 100% first try**, seven times faster on the vendor
model. The other three features have no baseline yet, for the billing reason given below, so those
rows are absolute results against the app's own validators rather than comparisons.

### The regime, so a row can be read

| | |
|---|---|
| Server | Ollama 0.34.2, one request at a time, `http://127.0.0.1:11434/v1` |
| Hardware | NVIDIA **A10-4Q vGPU slice — 3.8 GiB VRAM**, 6 CPU cores, 53 GB RAM |
| Server settings | `OLLAMA_CONTEXT_LENGTH=8192 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0` |
| Offload | `qwen3:4b-instruct-2507-q4_K_M` runs 66% on the GPU and 34% on the CPU — it does not fit either |

### Open-weight candidates

| feature | model | n | validated | 95% CI | first try | mean attempts | median s | commonest rejection |
|---|---|---|---|---|---|---|---|---|
| ranges | `qwen3:4b-instruct-2507-q4_K_M` | 12 | 12/12 | [0.76, 1.00] | 100% | 1.00 | 55.7 | — |
| extract | `granite3.2-vision:2b` | 1 | 1/1 | [0.21, 1.00] | 100% | 1.00 | 156.3 | — |
| document | `granite3.2-vision:2b` | 2 | 1/2 | [0.09, 0.91] | 50% | 1.50 | 33.1 | unreachable (1) |
| treatmentText | `qwen3:4b-instruct-2507-q4_K_M` | 3 | 2/3 | [0.21, 0.94] | 67% | 1.33 | 244.3 | unreachable (1) |

Config: `inference.examples/open-local.json`, with `local-vision` pointed at
`granite3.2-vision:2b` — see *Which vision model, and why the table is not the whole answer* below,
because the shipped example deliberately names a different one.

The documents took the **page-images** route in every row: neither local model declares `caps.pdf`,
both declare `vision`, so the fixture's rendered page is what the model saw. No row here scored the
native-PDF route.

| feature | model | n | validated | median s | note |
|---|---|---|---|---|---|
| extract | `qwen2.5vl:3b`, CPU-only | 1 | 0/1 | 300.7 | hit the client ceiling, below |
| document | `qwen2.5vl:3b`, CPU-only | 2 | 0/2 | 300.7 | same |

`qwen2.5vl:3b` could not run on the GPU at all. The app sends a page at the width it really renders
(1568 px, [`src/lib/pdf-pages-for-model.ts`](src/lib/pdf-pages-for-model.ts)), which costs roughly
4096 image tokens, and the allocation fails outright on a 3.8 GiB card:

```
cudaMalloc failed: out of memory / failed to allocate CUDA0 buffer of size 1925738496
```

### The baseline: `ranges` on 2026-09-21, the rest still unrun

| feature | model | n | validated | 95% CI | first try | mean attempts | median s | commonest rejection |
|---|---|---|---|---|---|---|---|---|
| ranges | `claude-sonnet-4-6` | 12 | 12/12 | [0.76, 1.00] | 100% | 1.00 | 7.8 | — |

Run **2026-09-21**, `npm run bench:models -- --feature ranges`, against the committed
`inference.config.json` on the day `ranges` moved from `claude-opus-4-7` to `claude-sonnet-4-6`
there — the move is a cost decision ([`CORPUS.md`](CORPUS.md) §8) and this is the evidence that it
costs no accuracy. The intervals are identical to the open model's because n is 12 in both: twelve
cases cannot separate two models that each answer all twelve. What separates them is time — 7.8 s
against 55.7 s — and that is a statement about the hardware each ran on, not about the models.

`extract`, `document` and `treatmentText` still have no baseline. On **2026-09-20** every call came
back, before the model saw anything:

```
400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too
low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}
```

A second key on a different project returned the same thing, so it was the account, not the key.
Those three baselines are **absent, not zero**, and this page will not fill them by assumption. The
account has credit as of 2026-09-21 — `ranges` ran on it — so what is left is the document work:

```sh
ANTHROPIC_API_KEY=… npm run bench:models -- --feature extract,document,treatmentText
```

That failed attempt is what produced the harness's
[`refused` bucket](https://github.com/pablo-tech/pilos/pull/24): the billing error scored as a
*quality* failure and printed a frontier model at `0/12`. A benchmark that cannot tell "never
asked" from "answered badly" is worse than no benchmark, so the bucket was added, tested and
released *before* the run above — an account problem now buckets as `refused`, ahead of every
quality reason.

### The client's own ceiling is part of the result

The HTTP client sets no timeout, so the effective ceiling is Node's undici default: **300 seconds**
for headers and body. Every `unreachable — fetch failed` above is that ceiling, at ~300.7 s, not a
model declining. It is reported rather than raised: raising it needs a dependency this milestone
does not add, and a feature that takes five minutes is not one a user waits for. **A model that
cannot answer in 300 s cannot serve that feature here** — a deployment fact, not an artefact.

Latency is a real column, not a footnote. Every row shares one server, one request at a time, no
other load; an earlier run whose vision calls queued behind aborted generations reported two
`treatmentText` timeouts that this uncontended run does not, and was discarded rather than
published.

### Which vision model, and why the table is not the whole answer

`granite3.2-vision:2b` validated `extract` 1/1 above. It is still **not** the model
[`MODELS.md`](MODELS.md) ships, and this is the most important caveat on the page.

Asked to read the patient name off the same fixture page, `granite3.2-vision:2b` answered
`Alex Doe`. The name on the page is `TESTCASE, Alex (fictional)`. `qwen2.5vl:3b`, forced onto the
CPU, returned it **exactly** — in 403.9 s, past the ceiling.

The validator did not catch the invented name, and could not have: it checks that the response is a
medical report, that required fields are present, that confidence is in range. **A structurally
perfect extraction of a hallucinated name passes.** That is the honest limit of using the app's own
validator as the oracle — it is exactly the production bar, and the production bar does not include
factual fidelity to the source. Read `validated` as *"production would have accepted this"*, never
as *"this is true"*.

So on 4 GiB: the accurate vision model is too slow and the fast one is unfaithful.
`inference.examples/open-local.json` names the accurate one, because a stack that fails to load is
a better failure than a stack that files a confident wrong name into someone's record.

### What this changes

- `INFERENCE.md`'s "written and checked against Claude" sentence is gone; the claim is measured now.
- `ranges` and `treatmentText` are named as open-model features in [`MODELS.md`](MODELS.md), and
  `inference.examples/mixed.json` routes them locally by default.
- The document features are named as needing more GPU than was measured, with no guess about how
  much more.

## Not measured

Named, because absence of a number is reported as absence and never as a pass.

| Not measured | Why |
|---|---|
| `chat`, `persona`, `leafRegen` | conversational output with no structural validator to act as an oracle. Scoring them needs a rubric, and a rubric graded by a model is not evidence. |
| `treatmentImage` | no synthetic photograph of a product exists, and a rendered document is not one. Measuring the image path on a page image would report a number for something nobody does. |
| `markerGroups` | grouping runs a convergence loop rather than a single validated call; it needs its own probe. |
| Open-weight models larger than ~4 GiB quantised | they do not fit the VRAM named in the pre-registration. A 12B or 20B model is plausibly better than the 4B one measured here, and this page has no evidence either way. |
| Scanned-PDF OCR | beyond what a vision model does natively. No scanned fixture, so no claim. |
| Cost per feature in currency | the runner reports calls and latency, not billing. Read the provider's own billing page. |
| Anything a run skipped for a declared missing capability | the row says skipped, and skipped is not zero. |
| **Factual fidelity to the source document** | the oracle is the shipped validator, which is a structural check. A response that invents a patient name passes it, and one did — see the vision-model caveat above. Measuring fidelity needs a per-field ground truth for every fixture, which does not exist yet. |
| **Any feature as production actually runs it, where reports are attached** | every probe here sends its fixture alone. Production prepends the patient's own PDFs ([`CORPUS.md`](CORPUS.md)), so a production call carries a few hundred pages of context these scores never saw. The scores remain valid as a comparison *between models on the same prompt*, which is what they were pre-registered to be, and stop being a prediction of production accuracy, latency or cost. A stack running `REPORTS: "never"` is unaffected. |
| The native-PDF route on an open model | no local candidate declares `caps.pdf`, so every document row above scored the page-images route. The native route is measured only on a provider that supports it, which means the baseline — and the baseline has so far run only `ranges`, which sends no document. |

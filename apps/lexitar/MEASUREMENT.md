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

**Not yet run.** This section is deliberately empty and dated: the method and the pre-registration
above were committed first, and the table lands here when the run happens — whatever it says.

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

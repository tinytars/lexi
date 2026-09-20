# Models: the stacks you can run this on

[`INFERENCE.md`](INFERENCE.md) says how to configure a model. [`MEASUREMENT.md`](MEASUREMENT.md)
says how well a model does the job, and owns every number. **This page says which whole stacks are
worth picking**, what each one needs, and — the part most such pages leave out — which features
each one *cannot* serve.

Each stack below is a complete `inference.config.json`. Copy one over the committed file and the
app runs on it; nothing else changes.

```sh
cp inference.examples/open-local.json inference.config.json
```

## The three stacks

| Stack | File | Needs | Sends your record to |
|---|---|---|---|
| **Default** | the committed [`inference.config.json`](inference.config.json) | an Anthropic API key | Anthropic |
| **Mixed** | [`inference.examples/mixed.json`](inference.examples/mixed.json) | an Anthropic API key **and** a local OpenAI-compatible server | Anthropic for the document and reasoning features; nowhere for the rest |
| **Open, local** | [`inference.examples/open-local.json`](inference.examples/open-local.json) | a local OpenAI-compatible server and a GPU; **no vendor account, no key** | nowhere — it never leaves the machine |

### Default — Anthropic

What the repo ships and what the hosted deployment runs. Every feature works, including the two
document features and every photo path, because the provider declares all four capabilities.

Cost is per token at the vendor's list price; `finding` is the expensive one by an order of
magnitude. The `dev` block downgrades four features to Sonnet so the dev environment is cheap.

### Mixed — vendor where it must be, open where it was measured to hold

The point of `features` mapping **each feature to its own provider** is that you do not have to
pick one model for everything. This stack keeps the vendor on the features that need vision, native
PDF handling or long structured reasoning, and moves the features an open 4B model was measured to
hold onto a local server: `ranges`, `treatmentText`, and the benchmark's own model.

That is a real cut in both cost and data exposure — `ranges` runs per marker and is one of the
highest-volume calls the app makes — without giving up a single feature.

### Open, local — no vendor account at all

Every feature routed to a local server. Two providers rather than one, because the text model and
the vision model are different models behind the same `baseUrl`: `local-text` declares
`vision: false`, `local-vision` declares `vision: true`, and the document and photo features are
routed to the second one.

The config is the right shape. **Whether it delivers depends entirely on the GPU**, and the
hardware it was measured on was too small — see the honest verdict below. The vision model it names
is the one that read the fixture correctly, not the one that was fastest; on a card too small to
hold it, it will not load at all, which is the failure you want rather than the other one.

## What each stack serves

A feature a stack cannot serve is refused with a `422 model_unsupported` before any call, and the
affordance that would have produced it is disabled in the UI with the reason. Nothing is silently
degraded.

| Feature | Default | Mixed | Open, local |
|---|---|---|---|
| `chat`, `persona`, `leafRegen` | yes | yes | yes, text only (`local-text` has no vision, so photo attach is disabled) |
| `ranges`, `markerGroups` | yes | `ranges` local, `markerGroups` vendor | yes |
| `treatmentText` | yes | local | yes |
| `finding` | yes | vendor | yes, subject to the note below |
| `extract`, `document` | yes, native PDF | vendor | **only with a GPU larger than the one measured**; page images, never native PDF |
| `treatmentImage` | yes | vendor | **same** |

## The verdict, and its one big caveat

Read [`MEASUREMENT.md`](MEASUREMENT.md) for the numbers. The summary a deployer needs:

- **A 4B open model holds the shipped contract on the structured text features.** `ranges` — the
  app's highest-volume model call, with a ten-check validator — validated on every case, on the
  first attempt, with no retries. That is not a hedge: it is the same prompt, the same validator and
  the same retry loop production runs.
- **The document features were not made to work on a 4 GiB GPU.** The accurate vision model does not
  fit the card at all — the page the app really sends costs about 4096 image tokens and the
  allocation fails — and on the CPU it answers past the HTTP client's 300-second ceiling. The one
  that *does* fit passed the validator on an extraction and, on the same page, reported a patient
  name that is not on it. The validator is a structural check and cannot catch that, which is
  itself the finding. This is a hardware result, not a verdict on open vision models: a larger GPU
  was not tested and this page will not guess.
- **The vendor baseline could not be re-run**, for a reason that has nothing to do with models; see
  `MEASUREMENT.md`.

So: **Mixed is the stack to pick today** if you want less vendor exposure without losing a feature.
**Open, local** is the stack to pick if vendor-independence is the requirement and you have a real
GPU — and you should run the measurement yourself on your hardware before trusting the document
features, which is exactly what `npm run bench:models -- --config <your file>` is for.

## What is actually proven, and by what

Being precise about this, because "it works" is the claim that rots:

| Claim | Proven by | Runs in CI |
|---|---|---|
| every example file is a valid config | `tests/unit/inference-examples.test.ts` | yes |
| no example contains a credential | same test, on the raw file text | yes |
| a feature whose provider declares a capability really reaches the model with it | same test, driving each feature over a real socket against `tests/fixtures/fake-openai.ts` | yes |
| a feature whose provider lacks it is refused as a `422 model_unsupported`, never a 500 | same test | yes |
| the model on the other end answers *well* | `MEASUREMENT.md`'s run | no — it needs a model |
| a stack works end to end against a live server | `npm run test:live` — one real call per feature per stack | no, by design |

`npm run test:live` runs every example stack; name one with
`BENCH_LIVE_CONFIG=inference.examples/open-local.json npm run test:live`. It is excluded from
`npm run test` rather than skipped inside it, so it can never go green without its inputs.

CI proves the files are correct and the capability contract holds. It cannot prove a model is good,
because a model is not in the repository. That is the line between this page and
`MEASUREMENT.md`.

## Running a local server

Any server speaking OpenAI's `/v1/chat/completions` works — Ollama, vLLM, LM Studio. The examples
point at Ollama's default `http://127.0.0.1:11434/v1` and set `keyEnv: []`, because a local server
needs no key.

A local model is reachable from the Node self-host (`npm run serve:node`, the `Dockerfile`) and
from the CLI. It is **not** reachable from Cloudflare Pages, which runs the app's functions on
Cloudflare's network, not yours. Self-host if you want the open stack.

Changing the model for `chat`, `persona`, `finding` or `leafRegen` changes a brain's version stamp;
run `npm run brain:versions` and commit, as `INFERENCE.md` describes. That is deliberate friction —
a model change is a recorded act.

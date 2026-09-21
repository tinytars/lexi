# Inference: which model runs what

Every model call LexiTar makes, from the web routes (`functions/api/*`) and from the ingest CLI
(`scripts/`), is configured in one file: [`inference.config.json`](inference.config.json). To change
a model, a provider or a key, edit that file and set the env vars it names. There is nothing to
configure in the UI or the database.

**Never put a key in `inference.config.json`.** This repo is public. The file holds only the *names*
of the env vars that hold keys, and its loader (`src/lib/model-config.ts`) refuses to start if a
field looks like a key or `keyEnv` holds anything but an env var name. Keys go in:

- **Local dev and the Node self-host:** `.dev.vars`, which is gitignored. Copy it from
  `.dev.vars.example`.
- **Cloudflare Pages:** `wrangler pages secret put <NAME>`.
- **The CLI:** your shell environment.

## The file

```jsonc
{
  "providers": {
    // A named key pool. keyEnv is tried in order; the first env var that is set wins.
    "anthropic":         { "api": "anthropic", "keyEnv": ["ANTHROPIC_API_KEY"], "billingUrl": "https://…" },
    "anthropic-finding": { "api": "anthropic", "keyEnv": ["FINDING_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"] }
  },
  "features": {
    // Every feature below must be listed.
    "chat":    { "provider": "anthropic",         "model": "claude-sonnet-4-6" },
    "finding": { "provider": "anthropic-finding", "model": "claude-opus-4-7" }
  },
  // The CLI's --mode dev (or INFERENCE_MODE=dev): cheaper models for iterating.
  "dev": { "finding": "claude-sonnet-4-6" }
}
```

Separate providers exist so one feature's traffic can't spend another's credits. For example,
however many chat questions users ask, they can't drain the key the Finding refresh bills to.
If a provider's own key isn't set, it falls back along `keyEnv`. If none of the named vars is set,
the feature fails, and its error names the vars to set.

`billingUrl` is optional. When the provider reports it is out of credit, chat links to that URL.

## Features

| Feature | Where | What it sends | Needs |
|---|---|---|---|
| `chat` † | `/api/chat` | the question, the patient context, attached photos | tools, and vision to read attached photos |
| `persona` | `/api/persona-adapt` | a chat answer to restate | — |
| `extract` | `/api/extract`, CLI report import | an uploaded report | PDF input, JSON schema |
| `document` | `/api/document-extract` | an attached document | PDF input, JSON schema |
| `treatmentImage` | `/api/treatment-infer` | photos of a product | vision, JSON schema |
| `treatmentText` | `/api/treatment-infer` | pasted product text | JSON schema |
| `finding` † | `/api/refresh-finding`, CLI | the whole record | — (the reply is JSON written as prose) |
| `ranges` † | `/api/refresh-range`, CLI | one marker's history | JSON schema |
| `markerGroups` † | `/api/refresh-marker-groups`, CLI | marker names | JSON schema |
| `leafRegen` † | `/api/leaf-regen`, CLI | one section of the Finding, plus photos | tools, and vision for photos |
| `benchmarkWeakest` | `scripts/brain-benchmark.ts` only | benchmark fixtures | — |

**†** — sends the patient's source PDFs ahead of everything in the "what it sends" column, so it
additionally needs **PDF input** and answers `422 model_unsupported` on a provider without it.
[`CORPUS.md`](CORPUS.md) is that mechanism in full: what is attached, the page ceiling, and the
`REPORTS: "never"` switch that turns the whole column back off. The six unmarked features are
unattached by design and `CORPUS.md` §6 says why.

These work with no model at all: the vault, sign-in, manual entry, markers and charts, reference
material, and CSV/JSON export.

## Using another provider

`"api": "openai"` talks to any server that speaks OpenAI's `/v1/chat/completions`, including OpenAI
itself, Ollama, vLLM and LM Studio. Only `baseUrl` changes between them. An `openai` provider must
declare what its model can do in `caps`. When a request needs something the model lacks (a PDF
sent to a text-only model, say), the route answers `422 model_unsupported` and sends nothing.

### OpenAI

```jsonc
"providers": {
  "openai": {
    "api": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "keyEnv": ["OPENAI_API_KEY"],
    "caps": { "vision": true, "pdf": true, "jsonSchema": true, "tools": true },
    "billingUrl": "https://platform.openai.com/settings/organization/billing/overview"
  }
},
"features": {
  "chat": { "provider": "openai", "model": "<an OpenAI model id>" }
}
```

Then set `OPENAI_API_KEY` in `.dev.vars` or as a Pages secret.

### A local open model (Ollama)

```jsonc
"providers": {
  "local": {
    "api": "openai",
    "baseUrl": "http://localhost:11434/v1",
    "keyEnv": [],
    "caps": { "vision": false, "pdf": false, "jsonSchema": true, "tools": true },
    "maxTokensField": "max_tokens",
    "maxOutputTokens": 8192
  }
}
```

- `keyEnv: []` means no key is sent.
- `maxTokensField` covers servers that predate OpenAI's `max_completion_tokens`.
- `maxOutputTokens` clamps requests to what a small model's context can hold.
- A model on `localhost` is reachable from the Node self-host (`npm run serve:node`, the
  `Dockerfile`) and the CLI, not from Cloudflare Pages.

Point any subset of features at `local`. With the caps above and `REPORTS: "never"`, chat (without
photos), persona, pasted treatment text, ranges and marker groups work. PDF extraction and photos
answer `model_unsupported` — and so does every † feature above if reports are attached, since a
model that cannot read a PDF cannot be shown the record.

A missing capability is a routing problem, not a dead end: `features` maps **each feature to its own
provider**, so the fix for "my local model cannot read PDFs" is a vision-capable model on `extract`,
`document` and `treatmentImage`, not a degraded payload. Two worked-out stacks that do exactly that
ship in [`inference.examples/`](inference.examples/); [`MODELS.md`](MODELS.md) says what each one
can and cannot serve.

## What changes when you switch

- **Quality.** Measured, not assumed: [`MEASUREMENT.md`](MEASUREMENT.md) scores feature × model
  against the app's own validators, and [`MODELS.md`](MODELS.md) turns those numbers into stacks you
  can copy. Failed validations retry once, and then the refresh reports an error rather than saving
  a bad Finding.
- **Dropped features.** The `openai` adapter drops Anthropic's prompt caching (OpenAI caches on its
  own) and extended thinking.
- **Brain versions.** The model id is part of each brain's version stamp. Changing the `chat`,
  `persona`, `finding` or `leafRegen` model makes `tests/unit/brain-versions.test.ts` fail until you
  run `npm run brain:versions` and commit the result. That makes a model change a deliberate act.
- **Privacy.** Patient context goes to whichever provider a feature names. A local model keeps it on
  your machine. Check the provider's data terms before pointing a hosted deployment at it.

The adapter lives in `functions/_lib/inference/openai.ts`, the resolver in
`functions/_lib/inference/resolve.ts`. `tests/unit/openai-adapter.test.ts` runs the adapter against a
real HTTP server that speaks Chat Completions.

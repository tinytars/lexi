# LexiTar (app)

`apps/lexitar` is the LexiTar web app itself — see the repository root's
[`README.md`](../../README.md) for what LexiTar is and why, and
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) for the system design this file assumes rather than
repeats. What follows is specific to working inside this directory: local dev, the ingest CLI,
testing, and deploy.

## Local dev

From the repo root:

```
npm install
cp apps/lexitar/.dev.vars.example apps/lexitar/.dev.vars   # fill in the secrets the routes you're touching need
```

Then, from `apps/lexitar/`:

```
npm run dev             # Vite only — UI development, no backend
npm run dev:functions   # build + wrangler pages dev — full stack, Pages Functions included
```

Or run the backend off Cloudflare entirely — the Node self-host in `server/` (see
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#cloudflare-is-one-host-not-a-dependency)):

```
npm run build
STORE_PREFIX=local npm run serve:node   # reads .dev.vars; SQLite + blobs under .node-data/ (LEXI_DATA_DIR)
```

The same host as an image, data on a volume — usage at the top of [`Dockerfile`](Dockerfile); CI's
`lexitar-image` job builds and boots it.

`.dev.vars.example` documents every secret a route needs — chat, provider-token, WebAuthn, Google
OAuth — and why each is issued as a *distinct* value rather than shared across routes. Most local
UI work needs none of them.

Which model each AI feature uses, and which provider, is set in
[`inference.config.json`](inference.config.json). It can point at Anthropic, OpenAI, or a local open
model through Ollama; [`INFERENCE.md`](INFERENCE.md) shows how. The file names env vars, never
keys.

## Ingest CLI

`scripts/ingest.ts` turns a lab file into vault content — full pipeline in [`INGEST.md`](INGEST.md),
shape summarized in [`ARCHITECTURE.md`'s Ingest CLI section](../../ARCHITECTURE.md#ingest-cli-scripts).
Run from this directory:

```
# Initialize a new vault for an account (one time)
npm run ingest -- --init --client <id> --display-name "..."

# Add marker history from a lab export
npm run ingest -- ./labs.xlsx --client <id>

# Manage the watchlist (the markers surfaced most prominently)
npm run ingest -- --client <id> --add-marker "Vitamin D"
npm run ingest -- --client <id> --remove-marker "Ferritin"
```

Ingest reads and writes the same D1/R2 store the deployed app does — see [`AUTH.md`](AUTH.md) for
account/credential setup and [`VAULT.md`](VAULT.md) for the storage model. Raw source files are
gitignored; never commit one, synthetic or real.

## Testing

```
npm run check     # svelte-check + tsc
npm run test      # unit (vitest)
npm run test:e2e  # Playwright
TEST_BACKEND=node npm run test          # unit, with the Node host's SQLite/fs adapters for D1/R2
E2E_HOST=node npm run test:e2e          # e2e against server/node.ts instead of wrangler pages dev
```

Every e2e spec runs against seeded, credential-free fixtures (`tests/e2e/_synthetic.ts`'s
per-worker synthetic patients plus a local-only e2e clinician and support account) — none of it
needs a real credential, so the same suite runs unmodified in CI (`.github/workflows/ci.yml`'s
`lexitar` job).

## Deploy

The deployed app is two Cloudflare Pages projects (dev and prod), each built with `npm run build`
from this directory. `wrangler.jsonc` binds the R2 bucket and the two D1 databases
(`health-vault`, `health-identity-{dev,prod}`); Pages secrets (the model keys `inference.config.json` names,
`SESSION_SECRET`, `VAULT_TOKEN`, the provider tokens — full list in `.dev.vars.example`) are set
via `wrangler pages secret put`, never committed.

## Further reading

- [`VAULT.md`](VAULT.md) — the storage/encryption model in full detail.
- [`AUTH.md`](AUTH.md) — accounts, credentials, and the audit trail.
- [`API.md`](API.md) — the HTTP contract for `functions/`.
- [`INFERENCE.md`](INFERENCE.md) — which model runs each AI feature, and how to switch providers.
- [`MEASUREMENT.md`](MEASUREMENT.md) — how model quality is measured, and what it measured.
- [`INGEST.md`](INGEST.md), [`BLOOD.md`](BLOOD.md), [`DEXA.md`](DEXA.md), [`NARRATIVE.md`](NARRATIVE.md) —
  per-source ingest detail.
- [`BACKUP.md`](BACKUP.md) — snapshot/restore.
- [`CUTOVER.md`](CUTOVER.md), [`DPGA.md`](DPGA.md) — operational and governance detail.

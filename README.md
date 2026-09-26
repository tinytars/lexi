# LexiTar

[![CI](https://github.com/tinytars/lexi/actions/workflows/ci.yml/badge.svg)](https://github.com/tinytars/lexi/actions/workflows/ci.yml)
[![Community Health](https://img.shields.io/badge/dynamic/json?url=https://api.github.com/repos/tinytars/lexi/community/profile&query=$.health_percentage&suffix=%25&label=community%20health)](https://github.com/tinytars/lexi/community)

A patient handed a lab report full of unexplained biomarkers and reference ranges has been given
data, not understanding — and the gap between the two is where health literacy actually fails, not
in whether the numbers are available at all. LexiTar is a **Health Literacy Utility**: an encrypted
personal health record that translates a patient's own labs, imaging, and clinical history into
longitudinal, reference-range context they can act on, and compiles that into a **Physician
Consultation Blueprint™** — a structured document meant to make a doctor visit more productive, not
to replace one. It is education, not medicine: not a diagnostic engine, not a medical-advice
service, and not a commercial product.

LexiTar is developed as a **Digital Public Good** and maintained by the **Tiny Tars Foundation**, a
registered 501(c)(3) public charity (EIN 39-2278196), funded by community philanthropy rather than
by monetizing the data it holds.

> **New here?** [`START-HERE.md`](START-HERE.md) has two short ways in — a few minutes with no
> code, or about ten minutes to a running app.

## Why

**Absolute data sovereignty.** LexiTar is built on the principle that a patient's biometric data
belongs entirely to them. The system practices strict data minimization — hosting only the exact
reference data required to generate a patient's own blueprints — under a permanent
zero-monetization policy: no advertising, no medical remarketing, no selling, renting, or trading
personal or health data, ever.

That principle is enforced structurally, not just promised in copy. Every record is encrypted
client-side under a key the patient controls before it ever reaches storage — the operator holds
ciphertext, never plaintext, in the ordinary course of operating the app — uploaded documents
included, each sealed under its own key held inside that record. Two exceptions, both disclosed:
a revocable, fully audited organizational-recovery path, not a hidden backdoor; and the moment a
patient asks a question about one of their own documents, when the app decrypts it in memory to
send it to the model that answers. See
[`ARCHITECTURE.md`](ARCHITECTURE.md#the-vault-boundary-precisely-stated) for exactly what that
does and doesn't allow, and [`SECURITY.md`](SECURITY.md) for how to report a concern.

**No AI branding in the chrome, full disclosure of AI use.** The interface itself doesn't surface
the word "AI" — reference assessments, structured conclusions, translated terminology — because a
translation-layer tool and a "health AI product" read as very different things to the people this
utility serves, and the positioning here is deliberately the former. That is a display choice, not
a concealment: the app's own About panel discloses, plainly, that LexiTar reasons with a language
model, and every reference range or translated summary is framed as an educational lookup — never
as a diagnosis, a recommendation, or clinical decision support.

## What it does

```
@tinytars/vault      crypto, auth-client, auth-recovery, key-store, envelope-access
   |
   v
@tinytars/frame      session/auth controllers + screens (packages/frame, this repo)
   |
   v
apps/lexitar         Svelte UI + Cloudflare Pages Functions + a local ingest CLI (this repo)
```

`apps/lexitar` is the app: a Svelte single-page UI, a Cloudflare Pages Functions backend, and a
Node ingest CLI, built on two published packages this same repo also maintains. Full design in
[`ARCHITECTURE.md`](ARCHITECTURE.md); the shape at a glance:

- **Ingest** — a CLI pipeline that turns a lab PDF or spreadsheet into structured, unit-canonicalized
  marker data, with every reading traced back to the source file it came from. [Detail](ARCHITECTURE.md#ingest-cli-scripts).
- **The Finding DAG** — the derived-reasoning layer: a staleness-tracked graph of AI-generated
  content (translated markers, personalized reference ranges, treatment reasoning) that knows when
  its own inputs have changed and needs regenerating, rather than silently going stale.
  [Detail](ARCHITECTURE.md#svelte-ui-srclib).
- **Markers, treatment, chat, and patient-record tabs** — the views built on top of that graph and
  the raw ingest output. [Detail](ARCHITECTURE.md#svelte-ui-srclib).
- **The vault boundary** — encryption and decryption happen only in the browser and the CLI; the
  Cloudflare Pages backend moves ciphertext and never holds a key.
  [Detail](ARCHITECTURE.md#the-vault-boundary-precisely-stated).

## `packages/frame` — `@tinytars/frame`

This repo also maintains `@tinytars/frame`, the domain-neutral session/auth-controller package
LexiTar consumes above as a real npm dependency (`npm install @tinytars/frame @tinytars/vault
svelte`), published independently of `apps/lexitar`'s own release cadence — merging to `main`
auto-bumps and publishes its patch version, see [`CHANGELOG.md`](CHANGELOG.md).

It's six getter-parameterized controller factories (`vault-session.svelte.ts`,
`roster-session.svelte.ts`, `vault-principals.svelte.ts`, `recovery-controller.svelte.ts`,
`support-access.svelte.ts`, `account-methods.svelte.ts`) composing `@tinytars/vault`'s crypto and
access-policy primitives into stateful, UI-ready session orchestration, plus the screens
(`LoginScreen.svelte`, `Onboarding.svelte`) and generic menu/panel components
(`AccountMenu.svelte`, `LeafActionMenu.svelte`, `LeafCard.svelte`, `Diagnostics.svelte`,
`ExportTab.svelte`, `VisibilitySettings.svelte`) built on top of them. None of it is
LexiTar-specific — every controller takes its host's types and callbacks as dependencies rather
than importing them, which is what lets a different Svelte app mount the same six controllers
unmodified. Full design: [`packages/frame/ARCHITECTURE.md`](packages/frame/ARCHITECTURE.md).
Contributing to it specifically: [`packages/frame/CONTRIBUTING.md`](packages/frame/CONTRIBUTING.md).

## Running locally

```
npm install
cp apps/lexitar/.dev.vars.example apps/lexitar/.dev.vars   # fill in real values for the routes you need
npm run dev --workspace apps/lexitar                       # Vite only, UI development
npm run dev:functions --workspace apps/lexitar             # build + wrangler pages dev, full stack
```

`apps/lexitar/.dev.vars.example` documents every secret a given route needs (chat, WebAuthn, Google
OAuth, provider tokens) — most local UI work needs none of them. Tests:

```
npm run test --workspace apps/lexitar        # unit (vitest)
npm run test:e2e --workspace apps/lexitar    # Playwright — see playwright.config.ts's "synthetic"
                                              # project for the credential-free subset CI runs
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT — see `LICENSE`.

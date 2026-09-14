# Security policy

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/tinytars/lexi/security/advisories/new)
rather than opening a public issue. Include a description of the issue and, if you have one, a
minimal reproduction.

We aim to acknowledge reports within 5 business days. There is no bug bounty; this is a
volunteer-maintained project from a 501(c)(3).

## This repo carries no patient data, ever

Nothing under `apps/lexitar` or `packages/frame` stores, seeds, or fixtures real account or health
data. A running deployment's actual patient data lives only in Cloudflare R2 and D1, encrypted
client-side under a key the operator never holds — reachable exclusively through the deployed app
over its authenticated API, never through this repository or its git history. If you believe you
have found real patient data committed here, treat it as the most urgent class of report this
policy covers.

## Scope

In scope: `apps/lexitar` (the LexiTar web app — Svelte UI, `functions/` Pages Functions backend,
`scripts/` ingest CLI) and `packages/frame` (`@tinytars/frame`, the session/auth controllers and
UI it drives — `vault-session.svelte.ts`, `roster-session.svelte.ts`, `vault-principals.svelte.ts`,
`recovery-controller.svelte.ts`, `support-access.svelte.ts`, `account-methods.svelte.ts`,
`LoginScreen.svelte`, `Onboarding.svelte`, `AccountMenu.svelte`, and the rest).

Out of scope: the cryptography and access-policy primitives both of the above build on — those
live in [`@tinytars/vault`](https://github.com/tinytars/vault) and have their own `SECURITY.md`. A
report that turns out to be about key derivation, envelope framing, or access resolution rather
than this repo's own session orchestration or application logic belongs there, not here.

## Supported versions

Only the latest deployed revision of `apps/lexitar` and the latest published minor version of
`@tinytars/frame` receive security fixes, per `CHANGELOG.md`. `@tinytars/frame` is pre-1.0; expect
breaking changes between minor versions until 1.0.0.

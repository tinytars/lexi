# Contributing

## Before you open a PR

This repo is two things sharing one tree: `apps/lexitar`, the LexiTar web app, and
`packages/frame` (`@tinytars/frame`), the domain-neutral app-shell package LexiTar consumes as a
real npm dependency, not a monorepo shortcut. A PR touching session/auth controllers, screens, or
menu/popover primitives belongs in `packages/frame` — read its own
[`CONTRIBUTING.md`](packages/frame/CONTRIBUTING.md) first, since the "read this before adding a
sixth controller" rule lives there, not here. Everything else — the Svelte UI under
`apps/lexitar/src`, the ingest CLI under `apps/lexitar/scripts`, the Cloudflare Pages Functions
backend under `apps/lexitar/functions` — is this file's scope.

## This app carries no patient data, ever

Read [`SECURITY.md`](SECURITY.md) before touching anything under `apps/lexitar/scripts` or
`apps/lexitar/functions`. No test fixture, seed script, or doc example committed here is allowed
to contain real account or health data — a live deployment's actual patient data lives only in
Cloudflare R2 and D1, encrypted client-side under a key this repository never holds. A PR that
needs a fixture should generate synthetic values, never copy a real one with the names changed.

## Encryption happens in the browser and the CLI, never on the server

`apps/lexitar/functions` moves ciphertext and wrapped keys; it does not decrypt in the request
path, and a PR should not introduce a route where it does. If a change needs the server to see
plaintext patient data to work, that's usually a sign the feature belongs client-side or in the CLI
instead — the crypto/access model this constraint rests on is `@tinytars/vault`'s, not
reimplemented in this app; see [`ARCHITECTURE.md`](ARCHITECTURE.md) for how `apps/lexitar` composes
it, or [`@tinytars/vault`'s own `ARCHITECTURE.md`](https://github.com/tinytars/vault/blob/main/ARCHITECTURE.md)
for the primitive itself.

## Style

- No comments explaining *what* code does — name things so the code reads on its own. A comment
  earns its place only by explaining a non-obvious *why* (a hidden constraint, a workaround, an
  invariant a reader could otherwise violate by "fixing" the code).
- Tests hit real implementations, not mocks, unless there's no other option.
- Follow the ingest pipeline's existing extension-routed-parser shape (`apps/lexitar/scripts`,
  `src/lib/parsers`) rather than introducing a new pattern for the same kind of problem — see
  [`ARCHITECTURE.md`](ARCHITECTURE.md) for the shape as it stands.

## Releases

`packages/frame` auto-bumps its own patch version and publishes to npm on every merge to `main` —
see [`packages/frame/CONTRIBUTING.md`](packages/frame/CONTRIBUTING.md)'s Releases section; don't
hand-edit its `package.json` version. `apps/lexitar` has no release of its own: merging to `main`
deploys it directly via Cloudflare Pages.

## Reporting a security issue instead of filing a PR

See [`SECURITY.md`](SECURITY.md) — vulnerabilities go through GitHub's private vulnerability
reporting, not a public issue or PR, until triaged.

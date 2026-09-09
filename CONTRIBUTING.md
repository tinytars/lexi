# Contributing

## Before you open a PR

`packages/frame` is UI/session orchestration, not a primitive of its own — it composes
[`@tinytars/vault`](https://github.com/tinytars/vault)'s crypto and access-policy functions into
the controllers and components an app actually mounts. If your PR is really about key derivation,
envelope framing, or access resolution, it belongs in `tinytars/vault`, not here.

## The controller shape is deliberate — read it before adding a sixth

Every controller in this package (`vault-session.svelte.ts`, `roster-session.svelte.ts`,
`vault-principals.svelte.ts`, `recovery-controller.svelte.ts`, `support-access.svelte.ts`,
`account-methods.svelte.ts`) is a getter-parameterized factory: a plain function taking a `deps`
object of thunks and callbacks, returning an object of getters/setters and async methods backed by
Svelte 5 runes (`$state`/`$derived`). None of them read a global store or import a host
application's types. This is why the same six controllers work unmodified across different apps —
a new controller that captures a value instead of a thunk, or reaches for a module-level `$state`
instead of taking one as a dependency, breaks that portability for a convenience that doesn't
outlast the first second consumer. See `ARCHITECTURE.md`'s "Controller shape" section before
proposing a different pattern.

## What stays with the host, not the controller

Every controller here deliberately leaves the decrypted vault/record itself, and the sink that
persists it, to the host application (see each controller's own `Deps` interface). If a PR adds
vault mutation logic to a controller in this package, it's misplaced — this package orchestrates
*who* can open a vault and *how a session is entered*, never what the vault contains.

## Style

- No comments explaining *what* code does — name things so the code reads on its own. A comment
  earns its place only by explaining a non-obvious *why* (a hidden constraint, a workaround, an
  invariant a reader could otherwise violate by "fixing" the code).
- No dependencies beyond `@tinytars/vault` and `svelte` without discussion first.
- This package has no test suite yet (see `README.md`'s Tests section) — a PR that adds meaningful
  new controller logic should add a first one rather than extending the gap.

## Releases

Merging to `main` auto-bumps the patch version and tags/releases it — CI's `release` job in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) does this after typecheck passes, and its
own commit carries `[skip ci]` so it doesn't trigger itself again. Don't hand-edit the `version`
field in `packages/frame/package.json` — the automation owns patch.

A MINOR or MAJOR bump is still a human call: bump the version yourself in a PR when a change earns
one (a new capability, a breaking API change). A [`CHANGELOG.md`](CHANGELOG.md) entry is the same
kind of deliberate, human-written call — not every patch bump gets one, only a release worth
explaining.

## Reporting a security issue instead of filing a PR

See `SECURITY.md` — vulnerabilities go through GitHub's private vulnerability reporting, not a
public issue or PR, until triaged.

# Security policy

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/tinytars/lexi/security/advisories/new)
rather than opening a public issue. Include a description of the issue and, if you have one, a
minimal reproduction.

We aim to acknowledge reports within 5 business days. There is no bug bounty; this is a
volunteer-maintained package from a 501(c)(3).

## Scope

In scope: everything under `packages/frame` — the session/auth controllers
(`vault-session.svelte.ts`, `roster-session.svelte.ts`, `vault-principals.svelte.ts`,
`recovery-controller.svelte.ts`, `support-access.svelte.ts`, `account-methods.svelte.ts`) and the
UI it drives (`LoginScreen.svelte`, `Onboarding.svelte`, `AccountMenu.svelte`, and the rest).

Out of scope: the cryptography and access-policy primitives this package builds on — those live in
[`@tinytars/vault`](https://github.com/tinytars/vault) and have their own `SECURITY.md`. A report
that turns out to be about key derivation, envelope framing, or access resolution rather than
session orchestration belongs there, not here. Also out of scope: vulnerabilities in an adopter's
own server-side auth routes — this package's controllers call a specific API shape (see
`ARCHITECTURE.md`) but do not implement or secure it.

## Supported versions

Only the latest published minor version receives security fixes, per `CHANGELOG.md`. This
package is pre-1.0; expect breaking changes between minor versions until 1.0.0.

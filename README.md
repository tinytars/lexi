# tinytars/lexi

LexiTar, the Tiny Tars Foundation's health-literacy app, and the pieces it's built from.

This is a small monorepo, not a single package:

- `packages/frame` (`@tinytars/frame`) — the domain-neutral app-shell package: auth/account chrome,
  upload/export mechanics, card/menu/modal primitives, diagnostics, and vault-unlock UI. Nothing here
  knows about health data specifically; it's meant to be reusable by any app built on
  [`@tinytars/vault`](https://github.com/tinytars/vault).
- `apps/lexitar` (planned) — the LexiTar web app itself, moving here from the private monorepo it was
  originally built in (`apps/health-dash-web` there). It will consume `@tinytars/frame` as a real
  package dependency rather than a same-repo relative import.

`packages/frame`'s history was preserved via `git subtree` from its original monorepo location, the
same way [`tinytars/vault`](https://github.com/tinytars/vault) was split from `packages/security`.

# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — 2026-09-14

### Added

- `apps/lexitar` — the LexiTar web app, moved here from its original private monorepo. Imported as
  a single squashed commit rather than with full history (the source history carries old versions
  of several docs/fixtures with real self-disclosed example content that would otherwise need a
  content-level filter to exclude — squashing off a clean HEAD made that unnecessary). No patient
  data, plaintext or encrypted, and none of the private repo's pilot-only operator scripts came
  with it; both stay behind in the source monorepo permanently.
- This repo's root docs (`README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `START-HERE.md`) rewritten so `apps/lexitar` is the repo's primary subject; `@tinytars/frame`'s
  own docs moved to `packages/frame/`.

## [0.1.0] — 2026-09-09

Initial extraction of `@tinytars/frame` from a health-literacy application's internal app-shell
code, landed via `git subtree split` to preserve its per-file history. First published version.

### Added

- Session/auth controllers: `vault-session.svelte.ts`, `roster-session.svelte.ts`,
  `vault-principals.svelte.ts`, `recovery-controller.svelte.ts`, `support-access.svelte.ts`,
  `account-methods.svelte.ts` — getter-parameterized factories composing `@tinytars/vault`'s
  crypto and access-policy primitives into session orchestration.
- Screens: `LoginScreen.svelte` (lock screen, sign-in/up, recovery redemption), `Onboarding.svelte`
  (first-run screen with caller-supplied field schema).
- Menu/popover primitives: `anchored-menu.svelte.ts` (portal + position + focus-trap), shared by
  `AccountMenu.svelte` and `LeafActionMenu.svelte`; `menu-registry.svelte.ts` (single-open-popover
  registry); `menu-items.ts`.
- File attachment: `attach-controller.ts` (picker registry) and `AttachPicker.svelte`.
- Generic panels: `LeafCard.svelte` (card shell + grid CSS), `Diagnostics.svelte` (audit-log
  viewer), `ExportTab.svelte`, `VisibilitySettings.svelte`.
- `brand.ts` — domain-neutral legal-link derivation.

### Known gaps

- No test suite yet (see `README.md`'s Tests section).
- No compiled `dist/` — the package ships raw `.svelte`/`.svelte.ts`/`.ts` source, same convention
  as `@tinytars/vault`. A build step is a tracked follow-up, not yet done.

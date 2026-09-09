# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-09-09

Initial extraction of `@tinytars/frame` from `plover-code`'s `apps/health-dash-web`, landed via
`git subtree split --prefix=packages/app-frame` (see `plover-code`'s
`docs/cross-app/13-generic-app-frame.md`). First published version.

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

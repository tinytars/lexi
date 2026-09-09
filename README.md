# tinytars/lexi

[![CI](https://github.com/tinytars/lexi/actions/workflows/ci.yml/badge.svg)](https://github.com/tinytars/lexi/actions/workflows/ci.yml)
[![Community Health](https://img.shields.io/badge/dynamic/json?url=https://api.github.com/repos/tinytars/lexi/community/profile&query=$.health_percentage&suffix=%25&label=community%20health)](https://github.com/tinytars/lexi/community)

LexiTar, the Tiny Tars Foundation's health-literacy app, and the pieces it's built from.

This is a small monorepo, not a single package:

- `packages/frame` (`@tinytars/frame`) — the domain-neutral app-shell package: auth/account chrome,
  upload/export mechanics, card/menu/modal primitives, diagnostics, and vault-unlock UI. Nothing here
  knows about health data specifically; it's meant to be reusable by any app built on
  [`@tinytars/vault`](https://github.com/tinytars/vault).
- `apps/lexitar` (planned) — the LexiTar web app itself, moving here from the private application it
  was originally built inside. It will consume `@tinytars/frame` as a real package dependency
  rather than a same-repo relative import.

`packages/frame`'s history was preserved via `git subtree` from its original monorepo location, the
same way [`tinytars/vault`](https://github.com/tinytars/vault) was split from `packages/security`.

## Why

A vault-unlock screen, an account menu, a "who has access to this" panel — every app built on
[`@tinytars/vault`](https://github.com/tinytars/vault) needs this chrome, and none of it is
specific to health data. `packages/frame` is that chrome, factored out once rather than rebuilt
per app: six session/auth controllers that compose `@tinytars/vault`'s primitives into stateful,
Svelte-ready surfaces, plus the screens and menu/card primitives that mount on top of them.

The controllers are the part worth reading closely before you write a seventh. Each one is a
plain factory taking a `deps` object of thunks and callbacks — never a captured value, never a
module-level store — so the same controller runs unmodified against a different host app's own
API routes and UI copy. `roster-session.svelte.ts` doesn't know it's LexiTar's; it knows the shape
of the calls its `deps` object promises to make. See `ARCHITECTURE.md` for the full list and
`CONTRIBUTING.md` for why that shape is enforced, not just conventional.

This package is UI/session orchestration, not a security primitive — it composes access decisions,
it doesn't make them. The actual cryptography and access-policy logic live one layer down, in
`@tinytars/vault`, which has its own threat model and its own README.

## What it does

```
   @tinytars/vault -- crypto, key-store, auth-client, auth-recovery, auth-grants, auth-support
                             |
                             |  composed by
                             v
   session/auth controllers (this package's six *.svelte.ts factories)
                             |
                             |  mounted by
                             v
   screens + menu/panel components (LoginScreen, Onboarding, AccountMenu, ...)
```

### Session/auth controllers

`vault-session.svelte.ts`, `roster-session.svelte.ts`, `vault-principals.svelte.ts`,
`recovery-controller.svelte.ts`, `support-access.svelte.ts`, `account-methods.svelte.ts` — six
getter-parameterized factories covering unlock, roster/cold-load resume, principal management and
key rotation, the recovery-code ladder, the support-agent console, and account/login-method
management. Full breakdown: [`ARCHITECTURE.md` § Session/auth
controllers](ARCHITECTURE.md#sessionauth-controllers).

### Screens

`LoginScreen.svelte` (lock screen, sign-in/up, recovery redemption) and `Onboarding.svelte`
(first-run screen with a caller-supplied field schema) — both driven entirely by props and
interfaces the host supplies, no hardcoded copy or question set. Details:
[`ARCHITECTURE.md` § Screens](ARCHITECTURE.md#screens).

### Menu and popover primitives

`anchored-menu.svelte.ts` is the shared positioning engine — portal-to-body, flip/clamp, focus
trap — behind every popover in this package; `menu-registry.svelte.ts` is the "only one open at a
time" singleton both `AccountMenu.svelte` and `LeafActionMenu.svelte` share. Details:
[`ARCHITECTURE.md` § Menu and popover
primitives](ARCHITECTURE.md#menu-and-popover-primitives).

### File attachment, and generic panels

`attach-controller.ts` + `AttachPicker.svelte` for file picking; `LeafCard.svelte`,
`Diagnostics.svelte`, `ExportTab.svelte`, and `VisibilitySettings.svelte` are fully caller-driven
panels with no vault or health-data awareness baked in. Details:
[`ARCHITECTURE.md` § File attachment](ARCHITECTURE.md#file-attachment) and [§ Generic
panels](ARCHITECTURE.md#generic-panels).

## Install

```
npm install @tinytars/frame @tinytars/vault svelte
```

`svelte` is a peer dependency — this package is built against Svelte 5 runes
(`$state`/`$derived`) and expects the host app to provide its own Svelte install.

## Quick start

This wires `vault-session.svelte.ts`'s session state to `LoginScreen.svelte`, the minimal shape
every host app builds on top of. It assumes an unlock function (`myUnlockVault`, composing
`@tinytars/vault/auth-client` against your own API) that returns a `VaultSession`.

```svelte
<script lang="ts">
  import { createVaultSession } from "@tinytars/frame/vault-session.svelte";
  import LoginScreen from "@tinytars/frame/LoginScreen.svelte";
  import { myUnlockVault, myRecoveryRedeem } from "./auth";

  const session = createVaultSession();
</script>

{#if session.entry}
  <p>Unlocked as {session.entry.accountId}</p>
{:else}
  <LoginScreen
    onSignIn={async (email, password) => {
      session.entry = await myUnlockVault(email, password);
    }}
    onSignUp={async (email, password) => {
      session.entry = await myUnlockVault(email, password);
    }}
    recovery={{ redeem: myRecoveryRedeem }}
  />
{/if}
```

This package ships TypeScript/Svelte source directly (no compiled `dist/`) — the subpath imports
above resolve via `package.json`'s `exports` map straight to the `.ts`/`.svelte` files, the same
convention [`@tinytars/vault`](https://github.com/tinytars/vault) uses. A bundler or TS-aware
toolchain (Vite/SvelteKit, esbuild, `tsx`) resolves them out of the box; a compiled build is a
tracked follow-up, not yet done.

## What's here

| Module | What it does |
|---|---|
| `vault-session.svelte.ts` | Unlocked-session key material as one `$state` object; re-exports `VaultEntry`/`VaultSession`/`openVault` from `@tinytars/vault` |
| `roster-session.svelte.ts` | Cold-load resume, owner/clinician/support routing, roster load/remove, patient drill-in |
| `vault-principals.svelte.ts` | Provider/support principal management + `rotateVaultKey()` |
| `recovery-controller.svelte.ts` | The recovery-code ladder: issue, regenerate, redeem, org-key revoke |
| `support-access.svelte.ts` | Support-agent console: list, request/cancel access, drill-in |
| `account-methods.svelte.ts` | Account profile, login-method add/remove/list, Google-link flow |
| `LoginScreen.svelte` | Lock screen: sign-in/up, recovery redemption |
| `Onboarding.svelte` | First-run screen with a caller-supplied field schema |
| `anchored-menu.svelte.ts` | Popover positioning/portal/focus-trap engine shared by every menu |
| `menu-registry.svelte.ts` | Singleton "which popover is open" registry |
| `menu-items.ts` | `LeafMenuItem` interface |
| `AccountMenu.svelte` | Top-right account dropdown (owner and providerAccess modes) |
| `LeafActionMenu.svelte` | Shared per-row "⋮" action menu |
| `attach-controller.ts` | Singleton file-picker registry |
| `AttachPicker.svelte` | Hidden file input driven by `attach-controller.ts` |
| `LeafCard.svelte` | Shared card shell + grid CSS |
| `Diagnostics.svelte` | Provider-only audit-log viewer |
| `ExportTab.svelte` | Generic "export this record" panel |
| `VisibilitySettings.svelte` | Generic feature-visibility toggle panel |
| `brand.ts` | `LegalLink` type + `deriveLegalLinks()` |

Full design — including why each controller takes thunks instead of captured values, and what
stays with the host rather than the controller — is in `ARCHITECTURE.md`.

## Contributing

See `CONTRIBUTING.md`. Read `ARCHITECTURE.md`'s "controller shape" framing before proposing a
seventh controller, and check whether your change is really about `@tinytars/vault` before
opening a PR here.

## Tests

`packages/frame` has no test suite yet — a known gap, stated here rather than left implicit. A PR
adding meaningful new controller logic should add the first one rather than extending the gap; see
`CONTRIBUTING.md`.

```
npm install
npm run typecheck --workspace packages/frame
```

## License

MIT — see `LICENSE`.

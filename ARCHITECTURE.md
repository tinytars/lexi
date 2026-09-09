# Architecture

This is the contract, not a tour — see `README.md`'s **What it does** for the featureset summary
an architect scans first. What follows is what a reader needs to adopt the package, write a new
controller, or judge whether a change to an existing one is safe.

`packages/frame` has one dependency shape, repeated across every controller: a plain factory
function takes a `deps` object (thunks, callbacks, and imports from `@tinytars/vault`) and returns
an object of getters and async methods backed by Svelte 5 runes. Nothing here reads a global store,
and nothing here imports a specific host application's types.

```
@tinytars/vault (crypto, auth-client, auth-recovery, auth-grants, auth-support, key-store, base64)
   |
   v
session/auth controllers (this package's *.svelte.ts factories)
   |
   v
screens + menu/panel components (this package's *.svelte files)
```

## Session/auth controllers

Six factories, each composing one or more `@tinytars/vault` auth modules into a stateful,
UI-ready surface. All six take their dependencies as thunks/callbacks rather than capturing
values, which is what lets the same controller run unmodified against different host apps — see
`CONTRIBUTING.md`'s "controller shape" section before adding a seventh.

- **`vault-session.svelte.ts`** — the foundation the other five build on. `createVaultSession()`
  holds an unlocked session's key material (`VaultEntry`, the DEK, the account keypair) as one
  `$state` object, and re-exports `VaultEntry`/`VaultSession`/`openVault` from
  `@tinytars/vault/vault-session` so a consumer never needs to import both packages for the same
  type. Every other controller in this package depends on the session shape this one defines.
- **`roster-session.svelte.ts`** — `createRosterSession(deps)`, the largest controller: cold-load
  resume (via a `hd_resume` marker, `RESUME_MARKER`), owner/clinician/support routing, roster
  load/remove, and patient drill-in. Imports `@tinytars/vault/key-store`, `/crypto`, `/base64`,
  `/auth-client`, and `/auth-grants` — it's the one controller that touches nearly every vault
  primitive, because it's the one responsible for deciding *which* session shape a caller ends up
  in after authenticating.
- **`vault-principals.svelte.ts`** — `createVaultPrincipals<V>(deps)`: lists and manages the
  provider/support principals who hold access to a vault, and implements `rotateVaultKey()` — the
  DEK re-key operation. Imports `@tinytars/vault/crypto`, `/base64`, `/auth-grants`,
  `/auth-support`, and `/auth-recovery`, since rotation touches every kind of principal at once.
- **`recovery-controller.svelte.ts`** — `createRecoveryController<P>(deps)`: the full recovery
  ladder — issuing and regenerating recovery codes, redeeming them, and org-key revoke. Imports
  `@tinytars/vault/auth-recovery` directly; this controller is a thin, stateful wrapper around
  that module's functions plus the UI-facing state (pending/error/success) around each step.
- **`support-access.svelte.ts`** — `createSupportAccess(deps)`: the support-agent console —
  listing pending/active requests, requesting or cancelling access, and patient drill-in once
  access is granted. Imports `@tinytars/vault/auth-support`.
- **`account-methods.svelte.ts`** — `createAccountMethods(deps)`: account profile state,
  login-method add/remove/list, the `ensureExtractableKey()` gate a method change needs before it
  can re-wrap the account's private key, and the Google-link popup flow. Imports
  `@tinytars/vault/auth-client` and `/auth-recovery`.

## Screens

- **`LoginScreen.svelte`** — the lock screen: sign-in, sign-up, and recovery-code redemption in
  one component, driven by a caller-supplied `LoginRecovery` interface rather than a hardcoded
  recovery flow, so a host can wire it to `recovery-controller.svelte.ts` or its own equivalent.
- **`Onboarding.svelte`** — the first-run screen, with a caller-supplied `OnboardingField[]`
  schema (`number`/`select` fields) rather than hardcoded questions — the same
  domain-neutrality the rest of the package holds to. Imports `onMount` from `svelte`.

## Menu and popover primitives

- **`anchored-menu.svelte.ts`** — the shared positioning engine behind every popover in this
  package: `placeMenu()` is a pure function computing a fixed-position rect (flip/clamp against
  viewport edges), and the `anchoredMenu` action wires it to a real element — portaling into
  `<body>`, rAF-throttled reposition on scroll/resize, a keyboard focus trap, and focus restore on
  close. `AccountMenu.svelte` and `LeafActionMenu.svelte` both use this action rather than
  duplicating popover mechanics.
- **`menu-registry.svelte.ts`** — a singleton `$state` registry answering one question: which
  popover, if any, is currently open. This is what lets opening one menu close another without
  either menu component needing a reference to its siblings.
- **`menu-items.ts`** — the `LeafMenuItem` interface shared by menu-driven components. Plain
  `.ts`, not `.svelte.ts` — it declares a shape, not reactive state, so it type-checks with `tsc`
  alone and doesn't need `svelte-check`.
- **`AccountMenu.svelte`** — the top-right account dropdown. Supports both an "owner" mode and a
  "providerAccess" mode, and every string it displays is prop-overridable rather than hardcoded
  copy, so a host can restyle its own vocabulary onto it. Uses `menu-registry.svelte.ts` and
  `anchored-menu.svelte.ts`.
- **`LeafActionMenu.svelte`** — the shared "⋮" per-row action menu, with an `openOnly()` helper
  for the common "only one row's menu open at a time" case. Uses the same registry and anchoring
  primitives as `AccountMenu.svelte`.

## File attachment

- **`attach-controller.ts`** — a singleton registry for an in-flight file picker, plus
  `AttachMode` and `DEFAULT_ATTACH_ACCEPT = "*/*"`. Plain `.ts`: it holds a callback reference,
  not Svelte state.
- **`AttachPicker.svelte`** — a single hidden `<input type=file>` driven by that controller.
  Imports `onMount` from `svelte`.

## Generic panels

None of the four components below know anything about vaults, accounts, or health data — they
take fully caller-supplied data and render it.

- **`LeafCard.svelte`** — the shared card shell and the `.rg-grid`/`.rg-col` global CSS classes
  every grid-of-cards layout in a host app builds on. Imports `Snippet` from `svelte`'s type
  exports for its slot content.
- **`Diagnostics.svelte`** — a provider-only audit-log viewer, typed against a caller-supplied
  `DiagnosticsLogEntry[]`.
- **`ExportTab.svelte`** — a generic "export this record" panel, driven entirely by a
  caller-supplied `ExportOption[]` — this package has no opinion on what an export option means or
  produces.
- **`VisibilitySettings.svelte`** — a generic feature-visibility toggle panel.

## Domain-neutral utilities

- **`brand.ts`** — the `LegalLink` type and `deriveLegalLinks()`. This is the domain-neutral half
  of a brand split: a host app supplies its own legal-link URLs/labels, and this function derives
  the rest of a consistent link set from them, without this package hardcoding any brand's actual
  legal text.

## Two things worth reading before you adapt this

**Controllers hold session state, never vault content.** Every controller's `Deps` interface takes
the decrypted vault/record and the sink that persists it as caller-supplied values — this package
orchestrates *who* can open a session and *how a session is entered and left*, and stops there. See
`CONTRIBUTING.md`'s "what stays with the host" section.

**Nothing here is Svelte-framework-neutral, unlike `@tinytars/vault`.** Every controller is a
`.svelte.ts` file using runes (`$state`/`$derived`), and every screen/panel is a `.svelte`
component. `@tinytars/vault`'s functions are plain TypeScript with zero UI-framework coupling by
design (see its own `ARCHITECTURE.md`); this package is the layer that deliberately gives that
coupling up in exchange for a ready-to-mount UI. A non-Svelte host consumes `@tinytars/vault`
directly and writes its own equivalent of this package, rather than adopting `@tinytars/frame`.

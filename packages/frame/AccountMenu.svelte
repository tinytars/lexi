<script lang="ts">
  // Top-right account pulldown for a signed-in owner (self-service, !providerSession).
  // Collapses the former Account / Access / Sign out header buttons into one menu; the items
  // just open the existing Account/Access modals (email, sign-in methods incl. passkey/Google,
  // recovery) and call signOut — no new logic lives here.
  // providerAccess mode: a clinician drilled into a patient. The trigger/label shows the
  // PATIENT's identity with a "Provider access" badge; the menu only offers Back to roster + Sign
  // out (provider). Account/Access settings are the provider's own — they live on the roster page.
  import { menuRegistry } from "@tinytars/frame/menu-registry.svelte";
  import { anchoredMenu } from "@tinytars/frame/anchored-menu.svelte";

  let {
    email, emailConfirmed = true, providerAccess = false, onAccount, onAccess, onBackToRoster,
    onResendVerification, onSignOut, onTranslate, translating = false, translateTitle, onDiagnostics, onVisibility, onDag,
    onExport, onAbout,
    providerBadgeLabel = "Provider access", subjectFallback = "record", viewingSubjectLabel = "Viewing",
    backToRosterLabel = "← Back", accessLabel = "Who can access this",
    translateLabel = "↻ Translate", translateBusyLabel = "Generating…",
    translateBusyTitle = "This is still running — this takes a few minutes.",
  }: {
    email: string | null;
    emailConfirmed?: boolean;
    providerAccess?: boolean;
    onAccount?: () => void;
    onAccess?: () => void; // omitted for providers — they don't own a record to share
    onBackToRoster?: () => void;
    onResendVerification?: () => void;
    onSignOut: () => void;
    onTranslate?: () => void;
    translating?: boolean;
    translateTitle?: string;
    onDiagnostics?: () => void;
    onVisibility?: () => void;
    onDag?: () => void;
    // Export moved here from the sidebar's Profile row; omitted when no client is selected
    // (provider roster / support console).
    onExport?: () => void;
    // About is app-level, not provider/patient-specific, so it's offered in both modes.
    onAbout?: () => void;
    // Copy, all domain-flavorable — defaults are generic, callers override with their own vocabulary
    // (e.g. LexiTar's "patient"/"roster"/"Translation") rather than this package assuming one.
    providerBadgeLabel?: string;
    subjectFallback?: string;
    viewingSubjectLabel?: string;
    backToRosterLabel?: string;
    accessLabel?: string;
    translateLabel?: string;
    translateBusyLabel?: string;
    translateBusyTitle?: string;
  } = $props();

  // menuId identifies this instance in the shared menuRegistry so opening any other
  // popover (a leaf row's LeafActionMenu) closes this one.
  const menuId = $props.id();
  let open = $derived(menuRegistry.isOpen(menuId));
  let root: HTMLDivElement;
  // Panel is portaled to <body> by the anchoredMenu action; outside-click has to
  // check both `root` (the trigger) and `panelEl` (the portaled panel), mirroring LeafActionMenu.
  let triggerEl: HTMLButtonElement;
  let panelEl: HTMLDivElement | undefined;

  const initials = $derived((email ?? "?").trim().slice(0, 1).toUpperCase());

  function toggle() { if (open) menuRegistry.close(menuId); else menuRegistry.open(menuId); }
  function close() { menuRegistry.close(menuId); }
  function run(fn: () => void) { close(); fn(); }

  function onWindowClick(e: MouseEvent) {
    const target = e.target as Node;
    if (!open) return;
    if (root?.contains(target)) return;
    if (panelEl?.contains(target)) return;
    close();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onKeydown} />

<div class="account-menu" bind:this={root}>
  <button
    bind:this={triggerEl}
    class="account-trigger"
    class:unverified={!emailConfirmed && !providerAccess}
    class:provider={providerAccess}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={`${menuId}-panel`}
    title={providerAccess ? `${providerBadgeLabel} — viewing ${email ?? subjectFallback}` : (email ?? "Account")}
    onclick={toggle}
  >
    <span class="avatar" aria-hidden="true">{initials}</span>
    {#if providerAccess}<span class="badge">{providerBadgeLabel}</span>{/if}
    <span class="chevron" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <div
      id={`${menuId}-panel`}
      class="menu"
      role="menu"
      bind:this={panelEl}
      use:anchoredMenu={{ anchor: triggerEl, open }}
    >
      {#if email}
        <div class="menu-head">
          {#if providerAccess}<span class="menu-label">{viewingSubjectLabel}</span>{/if}
          <span class="menu-email" title={email}>{email}</span>
          {#if !emailConfirmed && !providerAccess}
            <span class="menu-badge">Email not verified</span>
          {/if}
        </div>
      {/if}
      {#if providerAccess}
        {#if onTranslate}
          <button role="menuitem" class="menu-item" disabled={translating} title={translating ? translateBusyTitle : translateTitle} onclick={() => run(onTranslate!)}>{translating ? translateBusyLabel : translateLabel}</button>
        {/if}
        {#if onDiagnostics}
          <button role="menuitem" class="menu-item" onclick={() => run(onDiagnostics!)}>Diagnostics</button>
        {/if}
        {#if onVisibility}
          <button role="menuitem" class="menu-item" onclick={() => run(onVisibility!)}>Visibility</button>
        {/if}
        {#if onDag}
          <button role="menuitem" class="menu-item" onclick={() => run(onDag!)}>DAG</button>
        {/if}
        {#if onBackToRoster}
          <button role="menuitem" class="menu-item" onclick={() => run(onBackToRoster!)}>{backToRosterLabel}</button>
        {/if}
        {#if onAbout}
          <button role="menuitem" class="menu-item" onclick={() => run(onAbout!)}>About</button>
        {/if}
        {#if onExport}
          <button role="menuitem" class="menu-item" onclick={() => run(onExport!)}>Export</button>
        {/if}
        <div class="menu-sep"></div>
        <button role="menuitem" class="menu-item danger" onclick={() => run(onSignOut)}>Sign out (provider)</button>
      {:else}
        {#if !emailConfirmed && onResendVerification}
          <button role="menuitem" class="menu-item" onclick={() => run(onResendVerification!)}>Resend verification email</button>
        {/if}
        {#if onAccount}
          <button role="menuitem" class="menu-item" onclick={() => run(onAccount!)}>Account settings</button>
        {/if}
        {#if onAccess}
          <button role="menuitem" class="menu-item" onclick={() => run(onAccess!)}>{accessLabel}</button>
        {/if}
        {#if onAbout}
          <button role="menuitem" class="menu-item" onclick={() => run(onAbout!)}>About</button>
        {/if}
        {#if onExport}
          <button role="menuitem" class="menu-item" onclick={() => run(onExport!)}>Export</button>
        {/if}
        <div class="menu-sep"></div>
        <button role="menuitem" class="menu-item danger" onclick={() => run(onSignOut)}>Sign out</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .account-menu { position: relative; display: block; width: 100%; }
  .account-trigger {
    display: flex; align-items: center; gap: 0.35rem; width: 100%; box-sizing: border-box;
    padding: 0.25rem 0.5rem 0.25rem 0.3rem; border: 1px solid var(--border); background: white;
    border-radius: 8px; font: inherit; cursor: pointer; min-height: 36px;
  }
  .account-trigger:hover { border-color: var(--accent); }
  .avatar {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: white;
    font-size: 0.8rem; font-weight: 600;
  }
  .account-trigger.unverified .avatar { background: var(--warn); }
  .account-trigger.provider { border-color: var(--accent); }
  .account-trigger.provider .avatar { background: var(--accent); }
  .badge {
    font-size: 0.65rem; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
    color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: 999px; padding: 0.1rem 0.5rem;
  }
  .menu-label { font-size: 0.65rem; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--muted); }
  .chevron { color: var(--muted); font-size: 0.7rem; margin-left: auto; }

  /* top/left/max-height are set inline by the anchoredMenu action (portaled to
     <body>, position: fixed, flip/clamp math in anchored-menu.svelte.ts) — no more hard-coded
     `bottom: 100%`; this only sets the panel's own look, not its placement. */
  .menu {
    z-index: 90;
    min-width: 240px; padding: 0.35rem; background: white;
    border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    display: flex; flex-direction: column; gap: 0.1rem;
  }
  .menu-head { padding: 0.4rem 0.6rem 0.5rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .menu-email { font-size: 0.85rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu-badge {
    align-self: flex-start; font-size: 0.65rem; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
    color: var(--warn); background: var(--warn-band); border: 1px solid var(--warn); border-radius: 999px; padding: 0.1rem 0.45rem;
  }
  .menu-item {
    text-align: left; padding: 0.5rem 0.6rem; border: none; background: none; border-radius: 6px;
    font: inherit; font-size: 0.9rem; color: var(--fg); cursor: pointer;
  }
  .menu-item:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .menu-item.danger { color: var(--alert); }
  .menu-sep { height: 1px; background: var(--border); margin: 0.25rem 0.3rem; }
</style>

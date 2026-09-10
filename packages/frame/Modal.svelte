<script lang="ts">
  // Generic modal overlay (backdrop + close), built on the native <dialog> element, which
  // supplies as BROWSER PRIMITIVES what a hand-rolled overlay previously did not have at all: a
  // focus trap, focus restore on close, an inert background, Escape handling, and top-layer
  // stacking. Hand-rolling a focus trap is ~80 lines of the most-often-wrong code in front-end
  // and still yields neither top-layer nor `inert`.
  //
  // What was broken with a hand-rolled overlay, across every call site:
  //   • NOTHING ever focused the panel. `tabindex="-1"` + `aria-modal="true"` told a screen reader the
  //     background was inert while a keyboard user could still Tab straight into it.
  //   • `<svelte:window onkeydown>` meant Escape closed EVERY mounted Modal at once, not the top one.
  //   • The backdrop closed on any click, with no dirty check — so a patient typing a long note lost
  //     all of it to one mis-aimed click, and to a text-selection drag released outside the panel.
  //
  // The API is deliberately unchanged for callers that have no unsaved state: `label` / `onClose` /
  // `wide` / `children` behave exactly as before, so most call sites change zero characters.
  import type { Snippet } from "svelte";
  interface Props {
    label: string;
    onClose: () => void;
    wide?: boolean;
    /**
     * The form state to watch, as a getter — e.g. `() => newNote`.
     *
     * Modal compares it against a snapshot taken WHEN THIS COMPONENT MOUNTS, which is exactly when the
     * modal opens (every call site guards it with `{#if addOpen && draft}`). Using the component's own
     * lifecycle is why there is no `$effect` and no separate tracker module here: the first design had
     * both, to observe an "is it open" transition the mount already is.
     *
     * Omitted means "never dirty" — right for the read-only hosts (About, attachment viewer, import).
     */
    snapshot?: () => unknown;
    discardMessage?: string;
    children: Snippet;
  }
  let {
    label,
    onClose,
    wide = false,
    snapshot = undefined,
    discardMessage = "Discard your unsaved changes?",
    children,
  }: Props = $props();

  // Captured once, at mount. Serialisable form state only (strings, numbers, small arrays), so a JSON
  // compare is exact for the values that matter. Being wrong in the SAFE direction — asking when
  // nothing really changed — costs one confirmation; the opposite silently discards a patient's work.
  const pristine = snapshot ? JSON.stringify(snapshot()) : null;
  const isDirty = (): boolean => pristine !== null && JSON.stringify(snapshot!()) !== pristine;

  let dialog = $state<HTMLDialogElement | null>(null);
  let confirmEl = $state<HTMLDialogElement | null>(null);
  // Where a backdrop press STARTED. A text-selection drag that begins inside the panel and releases
  // on the backdrop dispatches `click` at the backdrop — which used to close the modal and discard
  // everything typed. Requiring both press and release on the backdrop fixes that.
  let pressedOnBackdrop = false;

  // showModal() rather than the `open` attribute: only the former puts the dialog in the top layer,
  // makes the rest of the document inert, traps focus and restores it on close.
  $effect(() => {
    dialog?.showModal();
  });

  function requestClose(): void {
    if (isDirty()) confirmEl?.showModal();
    else onClose();
  }

  /** Escape (and any other user-agent dismiss) arrives as a cancelable `cancel` event — per dialog. */
  function onCancel(e: Event): void {
    e.preventDefault(); // never let the browser close it out from under an unsaved edit
    requestClose();
  }
</script>

<dialog
  bind:this={dialog}
  class="modal-panel"
  class:wide
  aria-label={label}
  oncancel={onCancel}
  onmousedown={(e) => (pressedOnBackdrop = e.target === dialog)}
  onclick={(e) => {
    if (e.target === dialog && pressedOnBackdrop) requestClose();
    pressedOnBackdrop = false;
  }}
>
  <div class="modal-inner">
    <button class="modal-close" aria-label="Close" onclick={requestClose}>×</button>
    {@render children()}
  </div>
</dialog>

<!-- Defined once here, not at 15 call sites. A nested <dialog> works because the top layer stacks;
     window.confirm() would block the event loop, cannot be styled, and is invisible to Playwright
     without a dialog handler. -->
<dialog bind:this={confirmEl} class="discard-confirm" aria-label="Discard changes?">
  <p>{discardMessage}</p>
  <div class="discard-actions">
    <button class="btn" onclick={() => confirmEl?.close()}>Keep editing</button>
    <button
      class="btn danger"
      onclick={() => {
        confirmEl?.close();
        onClose();
      }}>Discard</button
    >
  </div>
</dialog>

<style>
  /* The element IS the panel now; ::backdrop replaces the wrapper div the browser used to need. */
  .modal-panel {
    position: fixed;
    inset: 0;
    margin: 4rem auto auto;
    background: white;
    color: inherit;
    max-width: 46rem;
    width: calc(100% - 2rem);
    max-height: calc(100vh - 8rem);
    overflow-y: auto;
    border: none;
    border-radius: 12px;
    padding: 0;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  }
  .modal-panel::backdrop { background: rgba(0, 0, 0, 0.4); }
  .modal-panel.wide { max-width: min(70rem, 95vw); }
  /* Padding lives on an inner wrapper so a backdrop click is unambiguously outside the content: on
     the dialog itself, padding is part of the element's box and would swallow near-edge presses. */
  .modal-inner { position: relative; padding: 1.75rem 2rem 2rem; }
  .modal-close {
    position: absolute;
    top: 0.6rem;
    right: 0.8rem;
    border: none;
    background: none;
    font-size: 1.6rem;
    line-height: 1;
    color: var(--muted);
    cursor: pointer;
    padding: 0.2rem 0.4rem;
  }
  .modal-close:hover { color: var(--fg); }

  .discard-confirm {
    border: none;
    border-radius: 10px;
    padding: 1.25rem 1.5rem;
    max-width: 24rem;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
  }
  .discard-confirm::backdrop { background: rgba(0, 0, 0, 0.3); }
  .discard-confirm p { margin: 0 0 1rem; }
  .discard-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

  /* The desktop margin is dead space on a short phone viewport. */
  @media (max-width: 640px) {
    .modal-panel { margin-top: 1rem; max-height: calc(100vh - 2rem); width: calc(100% - 1rem); }
    .modal-inner { padding: 1.25rem 1rem 1.5rem; }
  }
  @media print { .modal-panel { display: none !important; } }
</style>

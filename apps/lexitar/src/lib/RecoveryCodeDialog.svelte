<script lang="ts">
  // W73 — the clinician's side of provider-issued recovery: one button on a patient row, and this
  // dialog showing the code once.
  //
  // The code is shown and never sent. That is not a UI preference — for the server to email it, the
  // server would have to be given it, and it already holds the wrapped DEK; anything holding both can
  // open the record. See RECOVERY.md I2. It also makes the identity check structural: the code reaches
  // the patient only by this clinician telling them, so there is no way to complete a recovery without
  // the conversation that verifies who is asking.

  import Modal from "@tinytars/frame/Modal.svelte";

  interface Props {
    patientName: string;
    code: string | null;
    expiresAt: string | null;
    busy: boolean;
    error: string | null;
    onClose: () => void;
  }
  const { patientName, code, expiresAt, busy, error, onClose }: Props = $props();

  // Modal (W70) supplies the focus trap, inert background, Escape handling and top-layer stacking that
  // a hand-rolled backdrop does not — and a11y-static.test.ts refuses to let a component grow its own.

  const expiresIn = $derived(
    expiresAt ? Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000)) : 0,
  );
</script>

<Modal label="Recovery code" onClose={onClose}>
  <h2>Recovery code for {patientName}</h2>

  {#if busy}
    <p class="rc-sub">Preparing a code…</p>
  {:else if error}
    <p class="rc-err">{error}</p>
  {:else if code}
    <p class="rc-sub">Read this to {patientName} over the phone, or hand it to them in person.</p>
    <p class="rc-code">{code}</p>
    <ul class="rc-notes">
      <!-- Stated here rather than in a runbook nobody opens. The clinician IS the identity check; if
           they do not know that, the control does not exist. -->
      <li><strong>Make sure you know who you are talking to</strong> — call the number you already have for them. This code lets whoever holds it reset the account.</li>
      <li>It works once, and expires in {expiresIn} minutes.</li>
      <li>It will not be shown again. If it goes astray, issue another — the old one stops working.</li>
      <li>They will be asked to choose a new password. Their old password, passkey and Google sign-in stop working.</li>
    </ul>
  {/if}
</Modal>

<style>
  h2 { font-size: 1rem; margin: 0 0 0.5rem; }
  .rc-sub { margin: 0 0 1rem; font-size: 0.85rem; color: var(--muted); }
  .rc-err { margin: 0 0 1rem; font-size: 0.85rem; color: var(--alert); }
  .rc-code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 1.6rem; letter-spacing: 0.08em; text-align: center;
    margin: 0 0 1rem; padding: 0.75rem; border-radius: 8px;
    background: var(--code-bg); user-select: all;
  }
  .rc-notes { margin: 0 0 1.25rem; padding-left: 1.1rem; font-size: 0.8rem; color: var(--muted); }
  .rc-notes li { margin-bottom: 0.35rem; }
</style>

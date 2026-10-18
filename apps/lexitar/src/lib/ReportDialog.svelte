<script lang="ts">
  // DPG 9B.3/9B.4/9B.6 and 9C.2 — the one report control, opened from a chat answer, a leaf menu or a
  // provider's row. One component, because three copies of a safety channel drift and two of them
  // stop working.
  //
  // It asks for words, not evidence. The report carries no document and nothing from the record (see
  // safety-report.ts), so a reviewer's next step is to ask this account — which is why the reference
  // is shown: it is what they will quote back.

  import Modal from "@tinytars/frame/Modal.svelte";
  import { fileSafetyReport, type ReportTarget } from "./safety-report";
  import { SAFETY_RESPONSE } from "./brand";

  interface Props {
    target: ReportTarget;
    onClose: () => void;
  }
  const { target, onClose }: Props = $props();

  const PROMPT: Record<ReportTarget["reason"], { title: string; ask: string }> = {
    "misleading-answer": {
      title: "Report an answer",
      ask: "What was wrong with it? If it could have led someone to the wrong decision, say so — that is the part we act on fastest.",
    },
    "illegal-content": {
      title: "Report illegal or abusive material",
      ask: "What did you see, and where? Do not paste the material itself.",
    },
    "abusive-account": {
      title: "Report this account",
      ask: "What has this account done? Access can be removed from your record with Revoke; this reaches a person who can act beyond your own record.",
    },
  };

  let note = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let reference = $state<string | null>(null);

  async function send(): Promise<void> {
    busy = true;
    error = null;
    try {
      reference = await fileSafetyReport(target, note);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal label={PROMPT[target.reason].title} {onClose}>
  <h2>{PROMPT[target.reason].title}</h2>

  {#if reference}
    <p class="rp-sub">Sent. Your reference is <code>{reference}</code>.</p>
    <p class="rp-sub">{SAFETY_RESPONSE}</p>
    <button type="button" onclick={onClose}>Close</button>
  {:else}
    <p class="rp-sub">{PROMPT[target.reason].ask}</p>
    <!-- Nothing from the record travels with this, which the user is told rather than left to assume. -->
    <p class="rp-note">We send your account id, what you were looking at, and what you write here. Your
      documents and your health data are not sent — a reviewer who needs them will ask you.</p>
    <label class="rp-label" for="report-note">What happened</label>
    <textarea id="report-note" class="rp-text" rows="4" maxlength="2000" bind:value={note} disabled={busy}></textarea>
    {#if error}<p class="rp-err">{error}</p>{/if}
    <div class="rp-actions">
      <button type="button" onclick={onClose} disabled={busy}>Cancel</button>
      <button type="button" class="rp-send" onclick={send} disabled={busy || note.trim().length === 0}>
        {busy ? "Sending…" : "Send report"}
      </button>
    </div>
    <p class="rp-sub">{SAFETY_RESPONSE}</p>
  {/if}
</Modal>

<style>
  h2 { font-size: 1rem; margin: 0 0 0.5rem; }
  .rp-sub { margin: 0 0 0.75rem; font-size: 0.85rem; color: var(--muted); }
  .rp-note { margin: 0 0 0.75rem; font-size: 0.78rem; color: var(--muted); }
  .rp-label { display: block; font-size: 0.8rem; margin-bottom: 0.25rem; }
  .rp-text { width: 100%; box-sizing: border-box; margin-bottom: 0.75rem; font: inherit; font-size: 0.85rem; }
  .rp-err { margin: 0 0 0.75rem; font-size: 0.85rem; color: var(--alert); }
  .rp-actions { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
  .rp-send { font-weight: 600; }
</style>

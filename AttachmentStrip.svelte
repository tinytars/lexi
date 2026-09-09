<script lang="ts">
  import type { Attachment } from "./types";
  import { attachmentUrl } from "./attachment-store";
  import AttachmentViewer from "./AttachmentViewer.svelte";

  // W46 Phase 4/5 — the one shared display for a leaf's attachments[]: a row of small thumbnail
  // chips (image preview, or a document glyph for anything else), each opening the in-app viewer
  // (AttachmentViewer.svelte) instead of a bare new-tab link. Generalizes
  // UnifiedTreatment.svelte's/TreatmentRow.svelte's bespoke img-strip snippets, which this replaces.
  interface Props {
    attachments: Attachment[];
    clientId?: string | null;
    onRemove?: (a: Attachment) => void;
  }
  let { attachments, clientId = null, onRemove }: Props = $props();

  let openIndex = $state<number | null>(null);

  function chipTitle(a: Attachment): string {
    if (a.extracted?.error) return `${a.name} — couldn't be read: ${a.extracted.error}`;
    if (a.extracted?.kind) return `${a.name} — read as ${a.extracted.kind}`;
    return a.name;
  }
</script>

{#if attachments.length > 0 && clientId}
  <div class="attachment-strip">
    {#each attachments as a, i (a.key)}
      <div class="attachment-chip">
        <button type="button" class="attachment-link" onclick={() => (openIndex = i)} title={chipTitle(a)}>
          {#if a.mediaType.startsWith("image/")}
            <img src={attachmentUrl(clientId, a.key)} alt="" loading="lazy" />
          {:else}
            <span class="attachment-glyph" aria-hidden="true">📄</span>
          {/if}
        </button>
        <!-- A document that was read contributes its text to whatever LexiTar answers next; one
             that failed contributes nothing at all. That difference is invisible without a mark,
             and a silently-ignored document is exactly the failure this milestone set out to end. -->
        {#if a.extracted?.error}
          <span class="attachment-badge failed" title="Couldn't read this document: {a.extracted.error}">!</span>
        {:else if a.extracted && a.extracted.chars > 0}
          <span class="attachment-badge read" title="Read — {a.extracted.chars.toLocaleString()} characters available to LexiTar">✓</span>
        {/if}
        {#if onRemove}
          <button type="button" class="attachment-remove" onclick={() => onRemove(a)} aria-label="Remove {a.name}">✕</button>
        {/if}
      </div>
    {/each}
  </div>
  {#if openIndex !== null}
    <AttachmentViewer {attachments} bind:index={openIndex} {clientId} onClose={() => (openIndex = null)} />
  {/if}
{/if}

<style>
  .attachment-strip { display: flex; gap: 0.4rem; overflow-x: auto; margin-top: 0.4rem; padding-bottom: 0.1rem; }
  .attachment-chip { position: relative; flex: none; }
  .attachment-link {
    display: flex; align-items: center; justify-content: center;
    width: 56px; height: 56px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--band); overflow: hidden; padding: 0; cursor: pointer; font: inherit;
  }
  .attachment-link:hover { border-color: var(--accent); }
  .attachment-link img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .attachment-glyph { font-size: 1.4rem; }
  .attachment-remove {
    position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%;
    border: 1px solid var(--border); background: white; color: var(--muted); font-size: 0.65rem;
    line-height: 1; padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .attachment-remove:hover { color: var(--alert); border-color: var(--alert); }
  .attachment-badge {
    position: absolute; bottom: -4px; left: -4px; min-width: 16px; height: 16px; border-radius: 50%;
    border: 1px solid var(--border); background: var(--bg); font-size: 0.6rem; line-height: 1;
    display: flex; align-items: center; justify-content: center; padding: 0 2px;
  }
  .attachment-badge.read { color: var(--accent); }
  .attachment-badge.failed { color: var(--alert); border-color: var(--alert); }
</style>

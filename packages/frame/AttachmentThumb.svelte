<script lang="ts">
  import { resolveAttachmentUrl, type AttachmentUrl } from "./attachment-url.svelte";

  // One chip's image. Its own component because the URL resolves asynchronously and an {#each} body
  // has nowhere to keep per-item state.
  interface Props {
    clientId: string;
    fileKey: string;
    attachmentUrl: AttachmentUrl;
  }
  let { clientId, fileKey, attachmentUrl }: Props = $props();
  const src = resolveAttachmentUrl(() => ({ url: attachmentUrl, clientId, key: fileKey }));
</script>

{#if src.current}
  <img src={src.current} alt="" loading="lazy" />
{:else if src.error}
  <!-- The symbol, not the reason: a chip is too small for a message and the strip may be showing
       several. The viewer this chip opens is where the failure is named. -->
  <span class="failed" title={src.error} aria-label="This attachment could not be opened">⚠</span>
{/if}

<style>
  /* Here rather than in AttachmentStrip's .attachment-link img: a parent's scoped styles do not
     reach a child component's elements. */
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .failed {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 0.9rem;
  }
</style>

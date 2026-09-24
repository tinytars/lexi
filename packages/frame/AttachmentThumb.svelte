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
</style>

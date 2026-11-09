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

  let rootEl: HTMLSpanElement | undefined;
  let visible = $state(false);

  // The fetch is not what `loading="lazy"` defers. By the time the browser consults that attribute
  // the host has already fetched the object, decrypted it and minted a blob: URL, so the whole cost
  // is spent and only the decode is deferred — and the cost is the point here: a 56px chip pulls the
  // full stored original, and nine call sites draw this strip once per row, so a tab used to start
  // every download it would ever need the moment it opened. PdfThumbnail.svelte:21-31 gates the work
  // itself for the same reason and this is that gate. resolveAttachmentUrl already treats a null key
  // as nothing to do (attachment-url.svelte.ts:27), so the key IS the gate and no prop changes shape.
  $effect(() => {
    if (!rootEl || visible) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          obs.disconnect();
          visible = true;
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(rootEl);
    return () => obs.disconnect();
  });

  const src = resolveAttachmentUrl(() => ({ url: attachmentUrl, clientId, key: visible ? fileKey : null }));
</script>

<!-- The observed element, which the three arms below cannot supply between them: this component
     renders an <img>, a warning, or nothing at all, and "nothing at all" is exactly the state an
     un-scrolled chip is in. -->
<span class="thumb-root" bind:this={rootEl}>
  {#if src.current}
    <img src={src.current} alt="" loading="lazy" />
  {:else if src.error}
    <!-- The symbol, not the reason: a chip is too small for a message and the strip may be showing
         several. The viewer this chip opens is where the failure is named. -->
    <span class="failed" title={src.error} aria-label="This attachment could not be opened">⚠</span>
  {:else if !visible}
    <!-- Not an empty box: a chip the reader has not scrolled to has not failed, and said as faded
         rather than as absent. PdfThumbnail.svelte:56 is the same arm for the same state. -->
    <span class="pending" aria-hidden="true">🖼</span>
  {/if}
</span>

<style>
  /* Here rather than in AttachmentStrip's .attachment-link img: a parent's scoped styles do not
     reach a child component's elements. */
  .thumb-root {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
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
  .pending {
    font-size: 1.1rem;
    opacity: 0.4;
  }
</style>

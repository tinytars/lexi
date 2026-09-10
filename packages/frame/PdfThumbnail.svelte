<script lang="ts">
  import { openPdf } from "./pdf-render";

  // A report's first-page thumbnail on a reports list — the ER-doctor path: see the first page ->
  // click to scroll through the rest -> Download, no menu digging. Loads pdfjs (via the shared
  // pdf-render.ts) only once the card actually scrolls into view (IntersectionObserver), so a tab
  // with many reports doesn't pay pdfjs's ~500 KB cost until a thumbnail is actually about to
  // render.
  interface Props {
    url: string;
    onOpen?: () => void;
  }
  let { url, onOpen }: Props = $props();

  let rootEl: HTMLDivElement | undefined;
  let canvasEl = $state<HTMLCanvasElement | undefined>();
  let thumbState = $state<"pending" | "loading" | "ready" | "error">("pending");

  $effect(() => {
    if (!rootEl) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        obs.disconnect();
        load();
      }
    }, { rootMargin: "200px" });
    obs.observe(rootEl);
    return () => obs.disconnect();
  });

  async function load() {
    thumbState = "loading";
    try {
      const doc = await openPdf(url);
      thumbState = "ready";
      // canvasEl only exists once thumbState flips to "ready" and Svelte re-renders; await a tick via
      // requestAnimationFrame so bind:this has landed before we render into it.
      requestAnimationFrame(async () => {
        if (canvasEl) await doc.renderPage(1, canvasEl, 240);
      });
    } catch {
      thumbState = "error";
    }
  }
</script>

<div class="pdf-thumb" bind:this={rootEl}>
  <button type="button" class="pdf-thumb-btn" onclick={() => onOpen?.()} aria-label="Preview">
    {#if thumbState === "ready"}
      <canvas bind:this={canvasEl}></canvas>
    {:else if thumbState === "error"}
      <span class="pdf-thumb-glyph" aria-hidden="true">📄</span>
    {:else}
      <span class="pdf-thumb-glyph pdf-thumb-pending" aria-hidden="true">📄</span>
    {/if}
  </button>
</div>

<style>
  .pdf-thumb { flex: none; }
  .pdf-thumb-btn {
    display: flex; align-items: center; justify-content: center;
    width: 64px; height: 84px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--band); padding: 0; cursor: pointer; overflow: hidden;
  }
  .pdf-thumb-btn:hover { border-color: var(--accent); }
  .pdf-thumb-btn canvas { max-width: 100%; max-height: 100%; }
  .pdf-thumb-glyph { font-size: 1.6rem; }
  .pdf-thumb-pending { opacity: 0.5; }
</style>

<script lang="ts">
  import { speechRegistry } from "./speech-registry.svelte";

  // The global now-playing pill. Reading keeps going after its bubble unmounts (tab or leaf switch),
  // so this is the control that is always reachable. It renders nothing while idle.
  const now = $derived(speechRegistry.current());
  const playing = $derived(now.status === "playing");

  function reveal() {
    document.querySelector(`[data-speech-id="${now.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
</script>

{#if now.status !== "idle"}
  <div class="speech-controls" role="region" aria-label="Read aloud">
    <button type="button" class="sc-label" title="Show what is being read" onclick={reveal}>{now.label}</button>
    <span class="sc-progress" aria-label="Sentence {now.index + 1} of {now.total}">{now.index + 1} / {now.total}</span>
    <button
      type="button"
      class="sc-btn"
      title={playing ? "Pause reading" : "Resume reading"}
      aria-label={playing ? "Pause reading" : "Resume reading"}
      onclick={() => (playing ? speechRegistry.pause() : speechRegistry.resume())}
    >{playing ? "⏸︎" : "▶︎"}</button>
    <button type="button" class="sc-btn" title="Stop reading" aria-label="Stop reading" onclick={() => speechRegistry.stop()}>⏹&#xFE0E;</button>
  </div>
{/if}

<style>
  .speech-controls {
    position: fixed; bottom: 1rem; right: 1rem; z-index: 40;
    display: flex; align-items: center; gap: 0.35rem; max-width: calc(100vw - 2rem);
    padding: 0.3rem 0.4rem 0.3rem 0.8rem; border-radius: 999px;
    background: var(--panel); color: var(--fg); border: 1px solid var(--border);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18); font-size: 0.85rem;
  }
  .sc-label {
    border: none; background: none; color: inherit; cursor: pointer; padding: 0;
    font: inherit; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sc-progress { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sc-btn {
    border: none; background: none; cursor: pointer; color: var(--accent);
    font-size: 0.95rem; line-height: 1; padding: 0.35rem; border-radius: 999px;
  }
  .sc-btn:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
</style>

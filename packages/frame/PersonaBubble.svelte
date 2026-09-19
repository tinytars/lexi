<script lang="ts">
  import type { Snippet } from "svelte";
  import LeafActionMenu from "@tinytars/frame/LeafActionMenu.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { speechRegistry, isSpeechSupported } from "./speech-registry.svelte";

  // The one persona treatment: a tinted bubble with a head row (uppercase persona tag on the
  // left; an optional meta/date and an optional action icon, e.g. download, on the right). Colors
  // and layout live in theme.css's global .persona-* classes so every surface shares one language.
  type Persona = "assistant" | "owner" | "provider";
  // In-context head actions (edit/chat/delete/etc). `danger` tints the icon as destructive on hover.
  // These render collapsed into one LeafActionMenu, not one button per action.
  export type BubbleAction = LeafMenuItem;
  interface Props {
    persona: Persona;
    // Caller-supplied, matching how LoginScreen/Onboarding take their copy: this package has no
    // brand name or domain vocabulary of its own to fall back to.
    label: string;
    meta?: string;
    id?: string;
    // Pin folds into the shared LeafActionMenu (★/⋮ combined control) instead of a standalone
    // button; pinDisplay defaults to "auto" (hover-revealed ⋮ over the star).
    pinned?: boolean;
    onTogglePin?: () => void;
    pinDisplay?: "auto" | "hidden";
    actions?: BubbleAction[];
    children?: Snippet;
  }
  let { persona, label, meta, id, pinned = false, onTogglePin, pinDisplay = "auto", actions, children }: Props = $props();

  // Every assistant-generated bubble gets read-aloud for free. It reads bodyEl's rendered text at
  // click time instead of taking a prop, so no caller has to change. speechRegistry is the shared
  // player, and SpeechControls keeps playback controllable after this bubble unmounts.
  const uid = $props.id();
  const bubbleId = `${persona}-${uid}`;
  const speakable = $derived(persona === "assistant" && isSpeechSupported());
  const speech = $derived(speechRegistry.statusOf(bubbleId));
  const speakTitle = $derived(speech === "playing" ? "Pause reading" : speech === "paused" ? "Resume reading" : "Read aloud");
  let bodyEl: HTMLDivElement | undefined;
  function toggleSpeak() {
    speechRegistry.toggle(bubbleId, bodyEl?.textContent ?? "", meta ? `${label} · ${meta}` : label);
  }
</script>

<div class="persona-bubble p-{persona}" {id} data-speech-id={speakable ? bubbleId : undefined}>
  <div class="persona-head">
    <span class="persona-head-left">
      <span class="persona-tag">{label}</span>
    </span>
    {#if meta || actions?.length || onTogglePin || speakable}
      <span class="persona-head-right">
        {#if meta}<span class="persona-meta">{meta}</span>{/if}
        {#if speakable}
          <button
            type="button"
            class="persona-speak"
            class:active={speech !== "idle"}
            title={speakTitle}
            aria-label={speakTitle}
            onclick={toggleSpeak}
          >{speech === "playing" ? "⏸\uFE0E" : "▶\uFE0E"}</button>
          {#if speech !== "idle"}
            <button
              type="button"
              class="persona-speak"
              title="Stop reading"
              aria-label="Stop reading"
              onclick={() => speechRegistry.stop()}
            >⏹&#xFE0E;</button>
          {/if}
        {/if}
        {#if actions?.length || onTogglePin}
          <LeafActionMenu items={actions ?? []} {pinned} {onTogglePin} {pinDisplay} />
        {/if}
      </span>
    {/if}
  </div>
  {#if children}<div class="persona-body" bind:this={bodyEl}>{@render children()}</div>{/if}
</div>

<style>
  .persona-speak {
    flex-shrink: 0; border: none; background: none; cursor: pointer;
    font-size: 0.95rem; line-height: 1; padding: 0.3rem; border-radius: 6px; color: var(--muted);
  }
  .persona-speak:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--fg); }
  .persona-speak.active { color: var(--accent); }
</style>

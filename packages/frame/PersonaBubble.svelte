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

  // Every assistant-generated bubble gets Speak for free: reads bodyEl's own rendered text at click
  // time rather than a prop threaded through every one of this component's call sites, so no
  // existing caller needs to change. speechRegistry is the shared "only one thing speaks at a time"
  // singleton (mirrors menu-registry.svelte.ts); clicking the currently-speaking bubble's own button
  // again toggles it off (speechRegistry.speak handles that toggle internally).
  const uid = $props.id();
  const bubbleId = `${persona}-${uid}`;
  const speakable = $derived(persona === "assistant" && isSpeechSupported());
  const speaking = $derived(speechRegistry.isSpeaking(bubbleId));
  let bodyEl: HTMLDivElement | undefined;
  function toggleSpeak() {
    speechRegistry.speak(bubbleId, bodyEl?.textContent ?? "");
  }
</script>

<div class="persona-bubble p-{persona}" {id}>
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
            class:speaking
            title={speaking ? "Stop reading" : "Read aloud"}
            aria-label={speaking ? "Stop reading" : "Read aloud"}
            aria-pressed={speaking}
            onclick={toggleSpeak}
          >{speaking ? "⏸" : "🔊"}</button>
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
  .persona-speak.speaking { color: var(--accent); }
</style>

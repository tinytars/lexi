<script lang="ts">
  import type { Client } from "./types";
  import type { AnalysisItem } from "./analysis-items";
  import { analysisItemId } from "./analysis-items";
  import AiTurnCard from "./AiTurnCard.svelte";
  import { cellPin, type PinItem } from "./body-pin";

  // One Analysis turn as a leaf cell — the twin of ExplorationItemCard, and for the same reason.
  //
  // Its six blocks (Progression, On Treatment, System, Pattern, Synthesis, Final Thoughts) each
  // carried their own copy of this markup: AiTurnCard + a <p> + a per-file `.xx-text` style that
  // differed from its five siblings only in the class name. Adding the ★ would have meant adding it
  // six times. They render this instead, so the cell — and anything later added to it — exists once.
  // `onOpen` is set only by the search preview (mirrors QuestionPreview/GlossaryTermPreview);
  // the Analysis page itself omits it.
  interface Props { item: AnalysisItem; client: Client; onOpen?: () => void; onPin?: PinItem }
  let { item, client, onOpen, onPin }: Props = $props();

  const pin = $derived(cellPin(client, "analysis", analysisItemId(item), onPin));
</script>

<AiTurnCard anchor={item.anchor} label={item.label} {onOpen} pinned={pin?.pinned} onTogglePin={pin?.onTogglePin}>
  <p class="an-text">{item.text}</p>
</AiTurnCard>

<style>
  .an-text { margin: 0; font-size: 0.92rem; line-height: 1.55; color: var(--fg); }
</style>

<script lang="ts">
  import type { Snippet } from "svelte";
  import TurnCard from "./TurnCard.svelte";
  import { PRODUCT_NAME } from "./brand";

  // A turn tuple whose patient half never happened — LexiTar raised it unprompted (Exploration's
  // test suggestions, every Analysis block). The patient side still renders, saying exactly that,
  // so the cell reads the same as Study's and Treatment's.
  interface Props {
    anchor: string; label: string; tag?: string; onOpen?: () => void; children: Snippet;
    // The cell's ★. Absent = this surface cannot pin, so no star renders (see body-pin.ts).
    pinned?: boolean;
    onTogglePin?: () => void;
  }
  let { anchor, label, tag, onOpen, children, pinned = false, onTogglePin }: Props = $props();
</script>

<TurnCard {anchor} {label} {tag} {onOpen} {pinned} {onTogglePin} ai={children} patientEmpty={`Not asked — ${PRODUCT_NAME} raised this.`} />

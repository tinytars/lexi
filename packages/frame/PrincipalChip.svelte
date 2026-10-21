<script lang="ts">
  import { TONE_VARS, type PrincipalTone } from "./principal-tone";

  // `.persona-tag` promoted from a class to a component. The shape and the five colour pairs already
  // exist in theme.css; what did not exist was a way to wear one OUTSIDE a `.p-*` bubble, because the
  // colour rules there are descendant selectors (`.p-owner .persona-tag`). A standalone row has no
  // such ancestor, so the pair arrives as two custom properties set on the element itself.
  //
  // The chip is the only coloured thing in a row. That is the whole legibility argument: one glance
  // sorts a list by what each entry IS, with no icon to learn and no colour spent on anything else.
  interface Props {
    label: string;
    tone?: PrincipalTone;
    /** A native tooltip for the long form, when the label is an abbreviation of it. */
    title?: string;
  }
  let { label, tone = "muted", title }: Props = $props();
</script>

<span
  class="persona-tag chip"
  {title}
  style:--chip-fg="var({TONE_VARS[tone].fg})"
  style:--chip-band="var({TONE_VARS[tone].band})"
>{label}</span>

<style>
  .chip { color: var(--chip-fg); border-color: var(--chip-fg); background: var(--chip-band); flex: none; }
</style>

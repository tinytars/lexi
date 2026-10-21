<script lang="ts">
  // How long the access lasts, asked at the moment of granting it. Radios rather than a `<select>`:
  // with two or three options a select hides the choice behind a tap and announces nothing until it
  // is opened, while a radio group announces "30 days, selected, 1 of 2" on arrival — which is the
  // difference between a default the person chose and one they never saw.
  //
  // The value is a count of HOURS because that is what the two approval endpoints already speak; 0
  // means no end date at all.
  interface Option { label: string; hours: number }
  interface Props {
    /** Read to the screen reader in place of a visible heading, e.g. "How long should this last?". */
    legend: string;
    /** Radio groups are keyed by name, so a page showing two rows must pass two different ones. */
    name: string;
    options: Option[];
    value: number;
    onChange: (hours: number) => void;
  }
  let { legend, name, options, value, onChange }: Props = $props();
</script>

<fieldset class="duration">
  <legend class="sr-only">{legend}</legend>
  {#each options as o (o.hours)}
    <label class="opt" class:selected={o.hours === value}>
      <input class="sr-only" type="radio" {name} value={o.hours} checked={o.hours === value} onchange={() => onChange(o.hours)} />
      <span>{o.label}</span>
    </label>
  {/each}
</fieldset>

<style>
  .duration { display: inline-flex; gap: 0; border: 1px solid var(--border); border-radius: 8px; padding: 0; margin: 0; overflow: hidden; background: var(--surface); }
  .opt { font-size: 0.85rem; padding: 0.35rem 0.7rem; cursor: pointer; color: var(--muted); border-left: 1px solid var(--border); }
  .opt:first-of-type { border-left: 0; }
  .opt.selected { background: var(--band); color: var(--accent); font-weight: 600; }
  /* The radio itself is visually hidden, so its focus ring would land nowhere; the label wears it. */
  .opt:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
  @media (max-width: 640px) { .opt { min-height: 44px; display: inline-flex; align-items: center; } }
</style>

<script lang="ts">
  // W72 — one line per VISIT, expandable to the raw audit rows. See src/lib/access-episodes.ts for
  // why the grouping exists; this file is only its presentation.
  //
  // A native <details>/<summary> rather than a hand-rolled disclosure: it is keyboard-operable and
  // announced as an expander with no script at all, and tests/unit/a11y-static.test.ts sweeps every
  // component in this directory for exactly the kind of DIY overlay this would otherwise become.
  import { actionPhrase, episodeActions, type AccessEpisode } from "./access-episodes";

  const {
    episodes,
    nameFor,
    emptyText,
  }: {
    episodes: AccessEpisode[];
    /** Resolve an actor's account id to something a person recognises. */
    nameFor: (actorAccountId: string) => string;
    /** What to say when nothing matched — the two call sites mean different things by empty. */
    emptyText: string;
  } = $props();

  // An episode of one row shows its timestamp; a burst shows the span it covered, collapsed to one
  // date when it did not cross midnight. The raw per-row timestamps are in the expander either way.
  function when(ep: AccessEpisode): string {
    const to = new Date(ep.to);
    if (ep.count === 1 || ep.from === ep.to) return to.toLocaleString();
    const from = new Date(ep.from);
    if (from.toDateString() === to.toDateString()) {
      return `${to.toLocaleDateString()}, ${from.toLocaleTimeString()} – ${to.toLocaleTimeString()}`;
    }
    return `${from.toLocaleString()} – ${to.toLocaleString()}`;
  }
</script>

<ul class="al-list">
  {#each episodes as ep (ep.id)}
    <li>
      <details>
        <summary>
          <span class="al-who">{nameFor(ep.actorAccountId)}</span>
          <span class="al-what">{episodeActions(ep)}</span>
          <span class="al-when">{when(ep)}</span>
        </summary>
        <ul class="al-rows">
          {#each ep.events as ev (ev.id)}
            <li>
              <span class="al-what">{actionPhrase(ev.action)}</span>
              <span class="al-when">{new Date(ev.createdAt).toLocaleString()}</span>
            </li>
          {/each}
        </ul>
      </details>
    </li>
  {:else}
    <li class="al-empty">{emptyText}</li>
  {/each}
</ul>

<style>
  .al-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .al-list > li { border-bottom: 1px solid var(--border); }
  .al-list > li:last-child { border-bottom: none; }
  .al-empty { padding: 0.6rem 0.9rem; color: var(--muted); font-size: 0.9rem; }
  summary { padding: 0.6rem 0.9rem; cursor: pointer; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; }
  summary:hover { background: var(--hover, rgba(127, 127, 127, 0.08)); }
  .al-who { font-weight: 600; font-size: 0.9rem; }
  .al-what { color: var(--muted); font-size: 0.85rem; }
  .al-when { color: var(--muted); font-size: 0.8rem; margin-left: auto; white-space: nowrap; }
  .al-rows { list-style: none; margin: 0; padding: 0 0.9rem 0.5rem 1.6rem; }
  .al-rows li { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.2rem 0; font-size: 0.8rem; }
</style>

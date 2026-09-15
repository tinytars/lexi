<script lang="ts">
  import { isStamped } from "@pablotech/neuro";
  import { FINDING_DAG, upstreamOf, downstreamOf, dagNode, type NodeKind } from "./finding-dag";
  import { staleNodes } from "./staleness";
  import type { Client } from "./types";

  // W15a — provider-facing inspector for the Finding dependency graph. W15b — when a patient is
  // supplied (owner viewing their own vault), each node is coloured by staleness for that patient:
  // an edited input, a node gone stale by dependency, or fresh. Without a client it stays structural,
  // which is all the fam4 provider roster (names-only) can show. Click a node to trace upstream/downstream.
  interface Props { client?: Client | null }
  let { client = null }: Props = $props();

  let selected = $state<string | null>(null);

  const up = $derived(selected ? upstreamOf(selected) : new Set<string>());
  const down = $derived(selected ? downstreamOf(selected) : new Set<string>());

  let stale = $state(new Set<string>());
  $effect(() => {
    const c = client;
    if (!c?.finding) { stale = new Set(); return; }
    staleNodes(c).then((s) => { if (client === c) stale = s; });
  });
  const INPUT_KEYS = new Set(FINDING_DAG.filter((n) => n.kind === "source").map((n) => n.key));
  // "edited" = an input node whose own datum changed; "stale" = a derived node invalidated by it.
  function stateOf(key: string): "edited" | "stale" | "fresh" | "" {
    if (!client?.finding) return "";
    const node = dagNode(key);
    if (node && !isStamped(node)) return ""; // self-hashed out-of-band; not tracked by staleNodes
    if (!stale.has(key)) return "fresh";
    return INPUT_KEYS.has(key) ? "edited" : "stale";
  }

  const TIERS: { kind: NodeKind; title: string; blurb: string }[] = [
    { kind: "source", title: "Inputs", blurb: "raw / user-entered" },
    { kind: "derived", title: "Synthetic core", blurb: "generated together — one deep call" },
    { kind: "leaf", title: "Leaves", blurb: "input-local — the extract-for-web-regen candidates" },
    { kind: "projection", title: "Projections", blurb: "out-of-band — self-hashed, downstream of the taxonomy hub" },
  ];

  function nodesOf(kind: NodeKind) {
    return FINDING_DAG.filter((n) => n.kind === kind);
  }
  function rel(key: string): "sel" | "up" | "down" | "" {
    if (!selected) return "";
    if (key === selected) return "sel";
    if (up.has(key)) return "up";
    if (down.has(key)) return "down";
    return "";
  }
</script>

<div class="dag">
  <header class="dag-head">
    <h2>Translation DAG</h2>
    <p class="dag-lead">
      The dependency graph behind every patient's Translation — {FINDING_DAG.length} nodes. Click a node
      to trace what it's <span class="k-up">built from</span> and what an edit to it would
      <span class="k-down">invalidate</span> downstream.
      {#if client?.finding}Coloured for {client.displayName}: an <span class="s-edited">edited input</span>,
        a node <span class="s-stale">stale by dependency</span>, or <span class="s-fresh">fresh</span>.{/if}
    </p>
  </header>

  <div class="tiers">
    {#each TIERS as t (t.kind)}
      <section class="tier">
        <h3>{t.title} <span class="tier-blurb">{t.blurb}</span></h3>
        <div class="tier-nodes">
          {#each nodesOf(t.kind) as n (n.key)}
            <button class="node {t.kind} r-{rel(n.key)} st-{stateOf(n.key)}" onclick={() => (selected = selected === n.key ? null : n.key)}>
              <span class="node-label">{n.label}</span>
              {#if n.inputs.length}<span class="node-inputs">← {n.inputs.length}</span>{/if}
            </button>
          {/each}
        </div>
      </section>
    {/each}
  </div>

  {#if selected}
    {@const node = FINDING_DAG.find((n) => n.key === selected)}
    {#if node}
      <aside class="detail">
        <h4>{node.label} <span class="detail-kind {node.kind}">{node.kind}</span></h4>
        <p class="detail-basis">{node.basis}</p>
        <div class="detail-edges">
          <div>
            <h5 class="k-up">Built from ({up.size})</h5>
            {#if up.size}<ul>{#each [...up] as k (k)}<li>{FINDING_DAG.find((n) => n.key === k)?.label ?? k}</li>{/each}</ul>{:else}<p class="none">a raw input — nothing upstream.</p>{/if}
          </div>
          <div>
            <h5 class="k-down">Editing this invalidates ({down.size})</h5>
            {#if down.size}<ul>{#each [...down] as k (k)}<li>{FINDING_DAG.find((n) => n.key === k)?.label ?? k}</li>{/each}</ul>{:else}<p class="none">a leaf — nothing downstream.</p>{/if}
          </div>
        </div>
      </aside>
    {/if}
  {/if}
</div>

<style>
  .dag { max-width: var(--content-max); margin: 0 auto; }
  .dag-head h2 { margin: 0 0 0.4rem; font-size: 1.3rem; color: var(--accent); }
  .dag-lead { color: var(--muted); line-height: 1.5; margin: 0 0 1.5rem; font-size: 0.9rem; }
  .k-up { color: var(--p-owner); font-weight: 600; }
  .k-down { color: var(--alert); font-weight: 600; }
  .s-edited { color: var(--warn); font-weight: 600; }
  .s-stale { color: var(--alert); font-weight: 600; }
  .s-fresh { color: var(--p-owner); font-weight: 600; }

  .tiers { display: flex; flex-direction: column; gap: 1.1rem; }
  .tier h3 { margin: 0 0 0.5rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg); }
  .tier-blurb { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--muted); font-size: 0.78rem; }
  .tier-nodes { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .node {
    display: inline-flex; align-items: baseline; gap: 0.4rem;
    border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
    padding: 0.5rem 0.7rem; font: inherit; font-size: 0.85rem; cursor: pointer; min-height: 40px;
  }
  .node:hover { border-color: var(--accent); }
  .node.source { background: var(--surface); }
  .node.derived { background: var(--band); border-color: rgba(11,107,203,0.25); }
  .node.leaf { background: var(--gen-band); border-color: rgba(124,92,191,0.25); }
  /* W15b per-patient staleness — overrides the kind tint when a client is supplied. */
  .node.st-fresh { background: var(--p-owner-band); border-color: var(--p-owner); }
  .node.st-edited { background: var(--warn-band); border-color: var(--warn); }
  .node.st-stale { background: var(--alert-band); border-color: var(--alert); }
  .node-inputs { font-size: 0.72rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  /* Relationship highlighting when a node is selected. */
  .node.r-sel { outline: 2px solid var(--accent); outline-offset: 1px; }
  .node.r-up { box-shadow: inset 0 0 0 2px var(--p-owner); }
  .node.r-down { box-shadow: inset 0 0 0 2px var(--alert); }
  .dag:has(.node.r-sel) .node:not(.r-sel):not(.r-up):not(.r-down) { opacity: 0.4; }

  .detail { margin-top: 1.5rem; border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.1rem; background: white; }
  .detail h4 { margin: 0 0 0.4rem; font-size: 1rem; }
  .detail-kind { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.06em; border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.4rem; color: var(--muted); margin-left: 0.3rem; }
  .detail-basis { color: var(--muted); font-size: 0.86rem; line-height: 1.45; margin: 0 0 0.8rem; }
  .detail-edges { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .detail-edges h5 { margin: 0 0 0.3rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .detail-edges ul { margin: 0; padding-left: 1.1rem; }
  .detail-edges li { font-size: 0.85rem; line-height: 1.5; }
  .detail-edges .none { color: var(--muted); font-style: italic; font-size: 0.83rem; margin: 0; }
  @media (max-width: 560px) { .detail-edges { grid-template-columns: 1fr; } }
</style>

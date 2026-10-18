<script lang="ts" module>
  import type { Client } from "./types";

  export interface HypEval { pros: string[]; cons: string[]; alternatives: string[]; recommendation: string }

  // The AI's evaluation of each patient hypothesis (pros/cons/alternatives/recommendation), keyed
  // by intervention so a topic card can carry the AI's take on a matching patient item.
  export function buildHypothesisEvalMap(client: Client): Map<string, HypEval> {
    const m = new Map<string, HypEval>();
    for (const d of client.finding?.decisions?.patient ?? []) {
      m.set(d.intervention.trim(), { pros: d.pros, cons: d.cons, alternatives: d.alternatives, recommendation: d.recommendation });
    }
    return m;
  }
</script>

<script lang="ts">
  import { describeAiError } from "./ai-error";
  import type { ResolvedGroup, ResolvedPatientItem } from "./treatment-groups";
  import type { NoteAttachment } from "./types";
  import type { Permalink } from "./permalink";
  import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
  import LeafCard from "@tinytars/frame/LeafCard.svelte";
  import LeafActionMenu, { openOnly } from "@tinytars/frame/LeafActionMenu.svelte";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import { futureAnchor, ideaAnchor } from "./anchor";
  import { PRODUCT_NAME } from "./brand";
  import { onlyIndexed } from "@tinytars/frame/filter";
  import { standardLeafActions, buildNoteAttachment } from "./leaf-actions";

  // M91 Phase 3 — extracted from FutureTreatment.svelte's private per-topic LeafCard block.
  // Owner-locked: reused as-is at the topic granularity (a topic already bundles one patient
  // proposal + AI evaluation as a single interaction unit) — unlike decisionRow (the flat
  // patient-hypothesis editor), this is not split any finer. `onOpen` is set only by the search
  // preview (mirrors StudyRow/TreatmentRow); `onTogglePinDecision` is set only by the home tab
  // (search previews are read-only).
  interface Props {
    g: ResolvedGroup;
    evalByIntervention: Map<string, HypEval>;
    clientId?: string | null;
    onStartChat?: (pl: Permalink) => void;
    // M-annotate — this topic's "Annotate" menu item hands its attachment up to the shell.
    onCreateNote?: (attachment: NoteAttachment) => void;
    onTogglePinDecision?: (p: ResolvedPatientItem) => void;
    // M-translate — set only by the home tab (search previews are read-only, same as
    // onTogglePinDecision above); fires hypothesisEvaluation scoped to this one idea's label.
    onTriggerRegen?: (key: string, targetLabels?: string[], force?: boolean) => Promise<{ status: "filled" | "empty" | "skipped" | "failed"; error?: string }>;
    onOpen?: () => void;
    only?: { side: "patient" | "ai"; index: number };
  }
  let { g, evalByIntervention, clientId = null, onStartChat, onCreateNote, onTogglePinDecision, onTriggerRegen, onOpen, only }: Props = $props();

  // Translate is leaf-specific (like Markers' — see MarkerChart.svelte's rowActions), so it's a
  // manually-built LeafMenuItem rather than living in the shared standardLeafActions contract.
  // hypothesisEvaluation is a scopedArrayKey node (content-scoped by intervention, same as
  // FutureTreatment.svelte's save-trigger), so this only regenerates this one idea. force:true
  // bypasses the staleness gate so the click always fires (see App.svelte's regenNode comment);
  // stays visible even when an evaluation already exists so a provider can force a re-check.
  let translatingId = $state<string | null>(null);
  let translateErrorId = $state<string | null>(null);
  let translateError = $state<string | null>(null);
  async function doTranslate(p: ResolvedPatientItem) {
    translatingId = p.id;
    translateErrorId = null;
    translateError = null;
    try {
      const r = await onTriggerRegen?.("hypothesisEvaluation", [p.label], true);
      if (r?.status === "failed") { translateErrorId = p.id; translateError = r.error ?? "Couldn't translate."; }
      else if (r?.status === "empty") { translateErrorId = p.id; translateError = "Nothing to translate yet."; }
    } catch (e) {
      translateErrorId = p.id;
      // W64 — describeAiError, not the raw message: ai-error.ts maps a known code to a
      // patient-facing sentence and refuses to render a leaked JSON body ("never show it to a
      // patient"). Five of the seven Translate sites hand-rolled this and printed the SDK text.
      translateError = describeAiError(e);
    } finally {
      translatingId = null;
    }
  }
  function translateItems(p: ResolvedPatientItem) {
    return onTriggerRegen
      ? [{ key: "translate", label: translatingId === p.id ? "Translating…" : "Translate", title: "Translate", disabled: translatingId === p.id, onClick: () => doTranslate(p) }]
      : [];
  }

  // M103 — a scoped search result passes `only` to render just the matched idea; the other side
  // is hidden entirely (a scoped preview shows exactly one idea). Indices must stay the TRUE
  // original position since search-index.ts's hypothesisSearchLeaves computed `only.index` via
  // ideaAnchor(topic, side, index) over this same g.patient/g.ai ordering. Mirrors
  // ExplorationCell.svelte's identical scoping pattern.
  let patientIndices = $derived(
    only && only.side !== "patient" ? [] : onlyIndexed(g.patient.map((_, i) => i), only?.side === "patient" ? only.index : undefined),
  );
  let aiIndices = $derived(
    only && only.side !== "ai" ? [] : onlyIndexed(g.ai.map((_, i) => i), only?.side === "ai" ? only.index : undefined),
  );
</script>

<LeafCard
  items={standardLeafActions({
    chat: () => onStartChat?.({ client: clientId ?? undefined, tab: "ai", section: "futureTreatment", anchor: futureAnchor(g.topic) }),
    annotate: onCreateNote ? () => onCreateNote!(buildNoteAttachment(
      "group",
      { client: clientId ?? undefined, tab: "ai", section: "futureTreatment", anchor: futureAnchor(g.topic) },
      { title: g.topic, tag: "Hypothesis" },
    )) : undefined,
    extra: openOnly(onOpen),
  })}
>
  {#snippet title()}
    <span class="htc-topic"><HeadingAnchor anchor={futureAnchor(g.topic)} label="Copy link to this proposed treatment">{g.topic}</HeadingAnchor></span>
  {/snippet}
  {#each patientIndices as j (j)}
    {@const p = g.patient[j]}
    {@const ev = evalByIntervention.get(p.label.trim())}
    <div class="rg-grid htc-row" id={ideaAnchor(g.topic, "patient", j)}>
      <PersonaBubble persona="owner" label="Patient">
        <div class="htc-item-row">
          <div class="htc-name">{p.label}</div>
          <div class="row-actions">
            <LeafActionMenu
              items={translateItems(p)}
              pinned={p.pinned}
              onTogglePin={onTogglePinDecision ? () => onTogglePinDecision(p) : undefined}
            />
          </div>
        </div>
        {#if p.purpose}<p class="htc-purpose">{p.purpose}</p>{/if}
        {#if translateErrorId === p.id && translateError}<p class="htc-error">{translateError}</p>{/if}
      </PersonaBubble>
      <div class="rg-col">
        {#if ev}
          <PersonaBubble persona="assistant" label={PRODUCT_NAME}>
            {#if ev.recommendation}<p class="htc-rec">{ev.recommendation}</p>{/if}
            {#if ev.pros?.length || ev.cons?.length || ev.alternatives?.length}
              <details class="htc-eval">
                <summary>{PRODUCT_NAME}'s take</summary>
                {#each [{ h: "Pros", xs: ev.pros }, { h: "Cons", xs: ev.cons }, { h: "Alternatives", xs: ev.alternatives }] as blk (blk.h)}
                  {#if blk.xs?.length}
                    <div class="htc-poc">
                      <h6>{blk.h}</h6>
                      <ul>{#each blk.xs as x (x)}<li>{x}</li>{/each}</ul>
                    </div>
                  {/if}
                {/each}
              </details>
            {/if}
          </PersonaBubble>
        {:else}
          <p class="leaf-row-empty">No {PRODUCT_NAME} assessment.</p>
        {/if}
      </div>
    </div>
  {/each}
  {#each aiIndices as j (j)}
    {@const a = g.ai[j]}
    <div class="rg-grid htc-row" id={ideaAnchor(g.topic, "ai", j)}>
      <p class="leaf-row-empty">No patient equivalent.</p>
      <div class="rg-col">
        <PersonaBubble persona="assistant" label="{PRODUCT_NAME} also suggests">
          <div class="htc-name">{a.intervention}</div>
          {#if a.purpose}<p class="htc-purpose">{a.purpose}</p>{/if}
        </PersonaBubble>
      </div>
    </div>
  {/each}
</LeafCard>

<style>
  .htc-topic { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .htc-row { margin-bottom: 0.5rem; }
  .htc-row:last-child { margin-bottom: 0; }
  .htc-name { font-weight: 600; font-size: 0.92rem; color: var(--fg); }
  .htc-item-row { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; }
  .htc-purpose { margin: 0.3rem 0 0; font-size: 0.84rem; line-height: 1.45; color: var(--muted); }
  .htc-eval { margin: 0.45rem 0 0; border-top: 1px dashed var(--border); padding-top: 0.4rem; }
  .htc-eval > summary { cursor: pointer; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--p-assistant); list-style-position: inside; }
  .htc-rec { margin: 0; font-size: 0.84rem; line-height: 1.45; color: var(--fg); }
  .htc-poc { margin: 0.4rem 0 0; }
  .htc-poc h6 { margin: 0 0 0.15rem; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  .htc-poc ul { margin: 0; padding-left: 1.1rem; }
  .htc-poc li { font-size: 0.82rem; line-height: 1.4; color: var(--fg); }
  .row-actions { display: flex; align-items: center; gap: 0.35rem; flex: none; }
  .htc-error { color: var(--alert); font-size: 0.82rem; margin: 0.3rem 0 0; }
</style>

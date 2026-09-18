<script lang="ts">
  import type { Client, DecisionEntry, NoteAttachment, Attachment } from "./types";
  import { filterByGroup, isAllGroup } from "@tinytars/frame/group-filter";
  import { ALL_GROUP_KEY } from "./sidebar-labels";
  import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
  import PendingGrouping from "./PendingGrouping.svelte";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import Modal from "@tinytars/frame/Modal.svelte";
  import Button from "@tinytars/frame/Button.svelte";
  import Field from "@tinytars/frame/Field.svelte";
  import ModalActions from "@tinytars/frame/ModalActions.svelte";
  import SaveStatus from "@tinytars/frame/SaveStatus.svelte";
  import { futureAnchor, ideaAnchor, findByAnchor } from "./anchor";
  import HypothesisTopicCard, { buildHypothesisEvalMap } from "./HypothesisTopicCard.svelte";
  import { buildHypothesisGroups } from "./treatment-groups";
  import { systemAnalysisEstablished } from "@pablotech/akesi/system-groups";
  import { createDraftSync, createPersistNow } from "./draft-sync.svelte";
  import type { Permalink } from "./permalink";
  import LeafActionMenu from "@tinytars/frame/LeafActionMenu.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { standardLeafActions, buildNoteAttachment } from "./leaf-actions";
  import LeafCard from "@tinytars/frame/LeafCard.svelte";
  import TurnCard from "./TurnCard.svelte";
  import AttachmentStrip from "@tinytars/frame/AttachmentStrip.svelte";
  import { appendAttachments, attachmentUrl } from "./attachment-store";
  import DictateButton from "@tinytars/frame/DictateButton.svelte";
  import { sortPinnedFirst } from "./pin-sort";
  import { PRODUCT_NAME } from "./brand";

  // Future Treatment groups the patient's proposed treatments (Patient) with the AI's (AI), left↔right,
  // in the AI's priority order. W21: the grouping is AI-generated and stored on the Finding
  // (finding.treatmentGroups) — many-to-many, resolved here. Findings generated before W21 have no
  // treatmentGroups, so we fall back to the original client-side token/stem-similarity heuristic below.
  //
  // M53 — the AI-grouped/heuristic view above stays read-only (it's a many-to-many clustering, not a
  // 1:1 editable list); a separate flat editor for client.factors.decisions (the patient's own raw
  // hypotheses) sits above it, mirroring how Study edits `entries` independently of `studyResults`.
  interface Props {
    client: Client;
    clientId?: string | null;
    onSave?: (updated: Client) => void;
    // M66 P4 — fires from saveNewDecision (Add/Edit modal) with ideaAnchor(intervention, "patient", i),
    // matching the HeadingAnchor now on decisionRow. deleteDecision does not fire it (nothing to
    // scroll to post-delete).
    onSaved?: (anchor: string) => void;
    // M66 P7 — fires right after a patient-hypothesis-idea Add/Save so the shell can kick off a
    // background hypothesisEvaluation regen immediately, instead of waiting on its own staleness effect.
    onTriggerRegen?: (key: string, targetLabels?: string[], force?: boolean) => Promise<{ status: "filled" | "empty" | "skipped" | "failed"; error?: string }>;
    saved?: boolean;
    saveError?: string | null;
    // M70/Phase 0 — plumbing only; wired to a "Chat" button in a later phase.
    onStartChat?: (pl: Permalink) => void;
    // M-annotate — a hypothesis idea/topic's "Annotate" menu item hands its attachment up to the shell.
    onCreateNote?: (attachment: NoteAttachment) => void;
    // M75 — a sidebar "+" navigated here and wants the Add modal opened automatically.
    autoOpenAdd?: boolean;
    onAutoOpenAddConsumed?: () => void;
    // M76/Phase 4 — which sidebar body-system group (bare system name) is selected; the AI-grouped
    // view renders exactly that one system's topics instead of every system stacked. Bindable so the
    // pendingAnchor reverse-match effect below can switch it. The editable ideas list above stays
    // flat/ungrouped regardless.
    activeGroup?: string | null;
    // A deep-linked anchor whose owning system may not be the currently active one; reverse-matched
    // against the full unfiltered groups below, then cleared via onConsumeAnchor.
    pendingAnchor?: string | null;
    onConsumeAnchor?: () => void;
  }
  let {
    client, clientId = null, onSave, onSaved, onTriggerRegen, saved = false, saveError = null,
    onStartChat, onCreateNote, autoOpenAdd = false, onAutoOpenAddConsumed,
    activeGroup = $bindable(null), pendingAnchor = null, onConsumeAnchor,
  }: Props = $props();

  const canEdit = $derived(!!onSave);

  function build(c: Client): Client {
    const d = structuredClone($state.snapshot(c)) as Client;
    d.factors ??= {};
    d.factors.decisions ??= [];
    return d;
  }

  const ds = createDraftSync(() => client, build, () => saveError, () => canEdit);
  const draft = $derived(ds.draft);
  const persistNow = createPersistNow(ds, () => client, onSave, onSaved);

  // M57 — Add moves to a modal (mirrors Study/Treatment): its Save persists immediately, no outer
  // Save exists anymore. Every idea visible in the list is guaranteed already-persisted by the time
  // a row can be opened, so Delete/edit-Done never has to handle an "added but never saved" case.
  // M66 — Edit reopens this same modal (pre-filled) instead of an in-place row editor; editIndex
  // distinguishes edit from add and points at which draft/payload entry to overwrite on Save.
  let addOpen = $state(false);
  let newDecision = $state<DecisionEntry | null>(null);
  let editIndex = $state<number | null>(null);
  function openAdd() {
    newDecision = { id: crypto.randomUUID(), intervention: "", purpose: "" };
    editIndex = null;
    addOpen = true;
  }
  $effect(() => {
    if (autoOpenAdd) {
      openAdd();
      onAutoOpenAddConsumed?.();
    }
  });
  function openEditDecision(d: DecisionEntry, i: number) {
    newDecision = { ...d };
    editIndex = i;
    addOpen = true;
  }
  function cancelAdd() {
    addOpen = false;
    newDecision = null;
    editIndex = null;
  }
  function saveNewDecision() {
    if (!newDecision || !newDecision.intervention?.trim()) return;
    const idx = editIndex ?? (client.factors?.decisions?.length ?? 0);
    if (editIndex != null) {
      draft!.factors!.decisions![editIndex] = newDecision;
    } else {
      draft!.factors!.decisions!.push(newDecision);
    }
    persistNow((payload) => {
      payload.factors ??= {};
      payload.factors.decisions ??= [];
      if (editIndex != null) {
        payload.factors.decisions[editIndex] = newDecision!;
      } else {
        payload.factors.decisions.push(newDecision!);
      }
    }, ideaAnchor(newDecision.intervention, "patient", idx));
    onTriggerRegen?.("hypothesisEvaluation", [newDecision.intervention]);
    addOpen = false;
    newDecision = null;
    editIndex = null;
  }

  // M56 — persists immediately, scoped to just this item (see Study.svelte's deleteEntry for the
  // full rationale): built from the last-saved `client`, never the live `draft`.
  function deleteDecision(d: DecisionEntry, i: number) {
    const name = d.intervention?.trim() || "this idea";
    if (!confirm(`Remove ${name}? This can't be undone.`)) return;
    draft!.factors!.decisions!.splice(i, 1);
    persistNow((payload) => payload.factors!.decisions!.splice(i, 1));
  }
  // M-annotate — mirrors ChatTab.svelte's buildAttachment: a self-contained permalink + preview
  // back to this idea row, using the same anchor its "Chat" item already builds.
  function buildIdeaAttachment(d: DecisionEntry, i: number): NoteAttachment {
    return buildNoteAttachment(
      "idea",
      { client: clientId ?? undefined, tab: "ai", section: "futureTreatment", anchor: ideaAnchor(d.intervention, "patient", i) },
      { title: d.intervention || "Untitled", subtitle: d.purpose, tag: "Hypothesis" },
    );
  }
  let attachError = $state<string | null>(null);
  function attachToDecision(d: DecisionEntry, added: Attachment[]) {
    const match = draft!.factors!.decisions!.find((x) => x.id === d.id);
    if (match) match.attachments = appendAttachments(match.attachments, added);
    persistNow((payload) => {
      const m = payload.factors!.decisions!.find((x) => x.id === d.id);
      if (m) m.attachments = appendAttachments(m.attachments, added);
    });
  }
  // M71 P6 — standalone Pin toggle per idea, same scoped-persist shape as deleteDecision above:
  // mutate a clone of the last-saved `client` (never the live `draft`) and persist immediately.
  function togglePinDecision(d: DecisionEntry) {
    if (!draft) return;
    const flip = (c: Client) => {
      const match = c.factors?.decisions?.find((x) => x.id === d.id);
      if (match) match.pinned = !match.pinned;
    };
    flip(draft);
    if (!client.factors?.decisions?.some((x) => x.id === d.id)) return; // added this session, never saved
    persistNow(flip);
  }
  // Tagged with the original index so edit/delete still hit the right draft row.
  const taggedDecisions = $derived((draft?.factors?.decisions ?? []).map((d, i) => ({ d, i })));
  // W62 — these ARE filtered now, which the name always claimed: it only sorted, so the patient's
  // own ideas rendered under every body system, identically, no matter which one was selected.
  //
  // A DecisionEntry carries no system of its own — the AI's grouping is what knows, so the system is
  // read back from whichever group lists that decision.
  //
  // An idea the grouping does NOT place is shown under every filter, deliberately. The first cut
  // filed those under UNCATEGORIZED and filtered them like the rest, which meant a just-typed idea
  // disappeared the instant it was saved: Hypothesis defaults to a body system rather than All, and
  // a brand-new decision is in no group until the next Translate. An idea with no home yet has to
  // stay visible wherever you are; one the grouping HAS placed belongs to its system alone, which is
  // the actual bug this fixes.
  const systemOfDecision = $derived.by(() => {
    const m = new Map<string, string>();
    for (const g of groups ?? []) for (const p of g.patient) m.set(p.id, g.system);
    return m;
  });
  const filteredDecisions = $derived(
    sortPinnedFirst(taggedDecisions.map((x) => ({ ...x, pinned: x.d.pinned }))).filter((x) => {
      const system = systemOfDecision.get(x.d.id);
      return !system || isAllGroup(activeGroup, ALL_GROUP_KEY) || system === activeGroup;
    }),
  );

  // Primary path (W21): the AI's stored grouping, or null for a pre-W21 Finding → heuristic fallback.
  // W23: the committed Plan moved to its own "Treatment Plan" section — Speculation shows only the
  // patient's weighed hypotheses (kind "decision"), which also collapses "X" / "Start X (TBD)" dupes.
  // W25 — order the AI's stored groups by System Analysis (systemOrder), with any system-less group
  // labelled "Not yet categorized" and sorted last, so the body-system headings match every other
  // section. The heading dedup below (g.system !== previous) relies on this stable ordering.
  // M91 — grouping logic lives in treatment-groups.ts's buildHypothesisGroups (M103 — relocated
  // from HypothesisTopicCard.svelte's module script so search-index.ts can also call it), shared
  // with SearchPanel's hypothesis resolver.
  const groups = $derived(buildHypothesisGroups(client));

  // M76/Phase 4 — which single body system's topics render. Trusts activeGroup when it names a
  // system present in `groups`; otherwise defaults to the first group's system (or null if `groups`
  // is null/empty) — defensive only, since the real default-setting responsibility lives in
  // App.svelte's default-group effect.
  // W61 — one shared rule for every section (group-filter.ts): All shows everything, a named group
  // shows exactly its own topics, and an empty group renders empty rather than falling back to the
  // first system's — which is what made selecting a zero-count system show someone else's cells.
  const systemFilteredGroups = $derived(filterByGroup(groups ?? [], activeGroup, (g) => g.system, ALL_GROUP_KEY));

  // A deep-linked hypothesis anchor whose owning system isn't the currently active one would
  // otherwise never mount under single-system rendering. Reverse-match it against the full
  // `groups` (not systemFilteredGroups), switch to its owning system, then let the caller clear
  // pendingAnchor.
  $effect(() => {
    if (!pendingAnchor) return;
    const match = findByAnchor(groups ?? [], pendingAnchor, (g) => futureAnchor(g.topic));
    if (match) {
      activeGroup = match.system;
      onConsumeAnchor?.();
    }
  });

  // The AI's evaluation of each patient hypothesis (pros/cons/alternatives/recommendation),
  // keyed by intervention so a speculation bubble can carry the AI's take on it.
  // M91 — moved to HypothesisTopicCard.svelte's buildHypothesisEvalMap, shared with SearchPanel.
  const evalByIntervention = $derived(buildHypothesisEvalMap(client));

  type Hyp = { intervention: string; purpose: string };

  // Generic words that shouldn't drive a match (so "Methylation stack" pairs with "Methyl-B12 …
  // stack" on "methyl", not every "stack"; and no filler word forces a false pair).
  const STOP = new Set([
    "the", "and", "for", "with", "into", "toward", "as", "necessary", "including", "pair", "per", "plus",
    "while", "when", "stack", "inhibitor", "supplementation", "approach", "therapy", "agent", "dose",
    "daily", "high", "target", "targets", "values", "value", "increase", "improve", "restore", "start",
    "continue", "titrate", "support", "risk", "measured", "cut", "lift", "shift", "drive", "feed",
  ]);
  function stems(text: string): Set<string> {
    return new Set(
      (text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 5)),
    );
  }
  function sim(a: string, b: string): number {
    const A = stems(a);
    const B = stems(b);
    let n = 0;
    for (const s of A) if (B.has(s)) n++;
    return n;
  }

  // Greedy best-match: AI items in priority order each claim the most-similar unused patient item.
  const mapped: { ai: Hyp; patient?: Hyp }[] = $derived.by(() => {
    const ai = (client.finding?.decisions?.ai ?? []) as Hyp[];
    const patient = (client.factors?.decisions ?? []) as Hyp[];
    const used = new Set<number>();
    return ai.map((a) => {
      let best = -1;
      let bestScore = 0;
      patient.forEach((p, i) => {
        if (used.has(i)) return;
        const s = sim(a.intervention, p.intervention);
        if (s > bestScore) { bestScore = s; best = i; }
      });
      if (best >= 0) { used.add(best); return { ai: a, patient: patient[best] }; }
      return { ai: a };
    });
  });
  const unmatchedPatient: Hyp[] = $derived.by(() => {
    const ai = (client.finding?.decisions?.ai ?? []) as Hyp[];
    const patient = (client.factors?.decisions ?? []) as Hyp[];
    const matched = new Set(mapped.filter((m) => m.patient).map((m) => m.patient!.intervention));
    return patient.filter((p) => !matched.has(p.intervention));
  });
  const hasContent = $derived(mapped.length > 0 || unmatchedPatient.length > 0);
</script>

{#snippet decisionRow(d: DecisionEntry, i: number)}
  <LeafCard
    items={standardLeafActions({
      edit: () => openEditDecision(d, i),
      chat: () => onStartChat?.({ client: clientId ?? undefined, tab: "ai", section: "futureTreatment", anchor: ideaAnchor(d.intervention, "patient", i) }),
      annotate: onCreateNote ? () => onCreateNote!(buildIdeaAttachment(d, i)) : undefined,
      attach: clientId ? { clientId, onAttached: (added) => attachToDecision(d, added), onError: (msg) => (attachError = msg) } : undefined,
      delete: () => deleteDecision(d, i),
    })}
    pinned={!!d.pinned}
    onTogglePin={() => togglePinDecision(d)}
  >
    {#snippet title()}
      <HeadingAnchor anchor={ideaAnchor(d.intervention, "patient", i)} label="Copy link to this idea">
        <span class="ft-name">{d.intervention || "Untitled"}</span>
      </HeadingAnchor>
    {/snippet}
    {#if d.purpose}
      <p class="ft-purpose">{d.purpose}</p>
    {/if}
    <AttachmentStrip attachments={d.attachments ?? []} {clientId} {attachmentUrl} productName={PRODUCT_NAME} />
  </LeafCard>
{/snippet}

<div class="future-treatment leaf-section">
  {#if canEdit && draft}
    <div class="ft-editbar">
      <div class="fte-title">
        <SaveStatus {saved} />
      </div>
    </div>
    <SaveStatus error={saveError} />
    <SaveStatus error={attachError} />
    {#if taggedDecisions.length === 0}
      <p class="leaf-empty">No ideas yet — add one from the sidebar.</p>
    {:else}
      {#each filteredDecisions as { d, i } (d)}{@render decisionRow(d, i)}{/each}
    {/if}
  {/if}
  {#if groups}
    <!-- W21 primary path: the AI's stored grouping. -->
    {#if groups.length === 0}
      <p class="leaf-empty">No proposed treatment on record for {client.displayName}.</p>
    {:else if (systemFilteredGroups?.length ?? 0) === 0}
      <p class="leaf-empty">No proposed treatment for this system.</p>
    {:else}
      {#each systemFilteredGroups ?? [] as g (g.topic + g.system)}
        <HypothesisTopicCard
          {g}
          {evalByIntervention}
          {clientId}
          {onStartChat}
          {onCreateNote}
          {onTriggerRegen}
          onTogglePinDecision={(p) => togglePinDecision({ id: p.id, intervention: p.label, purpose: p.purpose ?? "", pinned: p.pinned })}
        />
      {/each}
    {/if}
  {:else if !hasContent}
    <p class="leaf-empty">No proposed treatment on record for {client.displayName}.</p>
  {:else}
    <!-- Fallback: no stored grouping — either the Finding hasn't run (pending note) or it predates
         W21 treatmentGroups (established, so no note); client-side token/stem-similarity heuristic. -->
    {#if !systemAnalysisEstablished(client)}<PendingGrouping />{/if}
    <p class="lead">What the patient proposes (Patient) mapped to what {PRODUCT_NAME} recommends ({PRODUCT_NAME}), in {PRODUCT_NAME}'s priority order. Grouped as one where they line up.</p>

    {#each mapped as m, i (i)}
      {#snippet patientTurn()}
        <div class="ft-name">{m.patient!.intervention}</div>
        {#if m.patient!.purpose}<p class="ft-purpose">{m.patient!.purpose}</p>{/if}
      {/snippet}
      {#snippet aiTurn()}
        <div class="ft-name">{m.ai.intervention}</div>
        {#if m.ai.purpose}<p class="ft-purpose">{m.ai.purpose}</p>{/if}
      {/snippet}
      <TurnCard
        items={standardLeafActions({
          chat: () => onStartChat?.({ client: clientId ?? undefined, tab: "ai", section: "futureTreatment" }),
          annotate: onCreateNote ? () => onCreateNote!(buildNoteAttachment(
            "idea",
            { client: clientId ?? undefined, tab: "ai", section: "futureTreatment" },
            { title: m.patient?.intervention || m.ai.intervention, tag: "Hypothesis" },
          )) : undefined,
        })}
        patient={m.patient ? patientTurn : undefined}
        ai={aiTurn}
        patientEmpty="No patient equivalent."
      />
    {/each}

    {#each unmatchedPatient as p, i (i)}
      {#snippet patientOnly()}
        <div class="ft-name">{p.intervention}</div>
        {#if p.purpose}<p class="ft-purpose">{p.purpose}</p>{/if}
      {/snippet}
      <TurnCard
        items={standardLeafActions({
          chat: () => onStartChat?.({ client: clientId ?? undefined, tab: "ai", section: "futureTreatment" }),
          annotate: onCreateNote ? () => onCreateNote!(buildNoteAttachment(
            "idea",
            { client: clientId ?? undefined, tab: "ai", section: "futureTreatment" },
            { title: p.intervention, tag: "Hypothesis" },
          )) : undefined,
        })}
        patient={patientOnly}
        aiEmpty={`No ${PRODUCT_NAME} recommendation.`}
      />
    {/each}
  {/if}
</div>

{#if addOpen && newDecision}
  <Modal label={editIndex != null ? "Edit idea" : "Add idea"} onClose={cancelAdd} snapshot={() => newDecision}>
    <div class="ft-modal">
      <Field label="Intervention" wide>
        <div class="field-row">
          <input class="topic-input" type="text" placeholder="e.g. Start Metformin" bind:value={newDecision.intervention} />
          <DictateButton onResult={(t) => (newDecision!.intervention = newDecision!.intervention ? `${newDecision!.intervention} ${t}` : t)} />
        </div>
      </Field>
      <Field label="Purpose" wide>
        <div class="field-row">
          <textarea class="ft-input" rows="2" placeholder="Purpose…" bind:value={newDecision.purpose}></textarea>
          <DictateButton onResult={(t) => (newDecision!.purpose = newDecision!.purpose ? `${newDecision!.purpose} ${t}` : t)} />
        </div>
      </Field>
      <ModalActions>
        <Button onclick={cancelAdd}>Cancel</Button>
        <Button primary onclick={saveNewDecision} disabled={!newDecision.intervention?.trim()}>Save</Button>
      </ModalActions>
    </div>
  </Modal>
{/if}

<style>
  .lead { color: var(--muted); margin: 0 0 1.25rem; line-height: 1.5; }
  .ft-name { font-weight: 600; font-size: 0.92rem; color: var(--fg); }
  .ft-purpose { margin: 0.3rem 0 0; font-size: 0.84rem; line-height: 1.45; color: var(--muted); }

  /* M53 — the "Your treatment ideas" editor (mirrors Study/Treatment's in-place CRUD). */

  .btn.del { color: var(--muted); font-size: 0.8rem; padding: 0.3rem 0.75rem; }
  .btn.del:hover { color: var(--alert); border-color: var(--alert); }
  .ft-input {
    font: inherit; font-size: 1rem; line-height: 1.55; color: var(--fg);
    padding: 0.65rem 0.8rem; border: 1px solid var(--border); border-radius: 7px;
    background: white; width: 100%; box-sizing: border-box; resize: vertical; min-height: 3.5rem;
  }
  .ft-input:focus, .topic-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--band); }
</style>

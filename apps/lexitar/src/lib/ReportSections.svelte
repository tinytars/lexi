<script lang="ts">
  import type { Client, NoteAttachment } from "./types";
  import { ALL_GROUP_KEY } from "./sidebar-labels";
  import HealthReports from "./HealthReports.svelte";
  import { togglePinnedIn } from "./vault-item-ops";
  import type { PinItem } from "./body-pin";
  import UnifiedTreatment from "./UnifiedTreatment.svelte";
  import FutureTreatment from "./FutureTreatment.svelte";
  import Glossary from "./Glossary.svelte";
  import QuestionsForDr from "./QuestionsForDr.svelte";
  import Personalization from "./Personalization.svelte";
  import Analysis from "./Analysis.svelte";
  import TestsToConsider from "./TestsToConsider.svelte";
  import Study from "./Study.svelte";
  import Notes from "./Notes.svelte";
  import Allergies from "./Allergies.svelte";
  import Family from "./Family.svelte";
  import MarkersTab from "./MarkersTab.svelte";
  import RecommendedMarkers from "./RecommendedMarkers.svelte";
  import type { Vault } from "./types";
  import type { UnitSystem } from "./units";
  import { presentSections, type SectionMeta } from "./report-sections";
  import { canSee } from "./visibility";
  import type { Permalink } from "./permalink";

  // W18 — a sectioned view over the report: a sub-tab bar plus the active section's content. Reused by
  // the Research and Profile tabs; the bar is hidden when a tab has a single section. Each section
  // renders its own persona-mapped component (W24 retired the FullReport slice).
  interface Props {
    client: Client;
    sections: SectionMeta[];
    clientId?: string | null;
    // W15/3a — the provider (drilled-in) sees every section; a patient's own session sees
    // only patient-audience sections per the provider's per-patient visibility policy.
    providerSession?: boolean;
    canTranslate?: boolean;
    // M59/Phase 4 — per-marker Ranges Translate, forwarded down to MarkersTab/MarkerChart. Returns a
    // Promise so MarkerChart can scope a failure to that one marker's own inline error state.
    onTranslate?: (client: Client, marker: string) => Promise<void>;
    // M95 — triggers web-side marker->body-system classification, forwarded to MarkersTab.
    onCategorizeMarkers?: (client: Client) => Promise<void>;
    // Markers sub-section (folded in from the retired top-level tab). windowYears stays owned by the
    // shell (the print doc needs it) and binds through. Only the Doctor Conversation invocation passes these.
    vault?: Vault;
    unitSystem?: UnitSystem;
    windowYears?: number;
    onToggleWatchlist?: (name: string) => void;
    onTogglePinnedRatio?: (name: string) => void;
    // Treatment CRUD — the provider edits factors.treatments in place via the shell's saveEdits path.
    activeLeaf?: string | null;
    onSave?: (updated: Client) => void;
    // M66 P4 — fires with the anchor of the item just saved/deleted, so the shell can re-permalink to
    // it (e.g. after Add, before the row existed to link to). No anchor target on Personalization.
    onSaved?: (anchor: string) => void;
    // M66 P7 — requests an immediate leaf regen (finding-dag node key) right after a save, instead of
    // waiting on the shell's own background staleness effect. Hypothesis/Treatment/Study/Notes use it.
    // The optional second arg (Study only) scopes the regen to just the row that changed — M92 Phase 8
    // Notes always triggers an unscoped regen (no per-note scoping yet; a note has no label to scope
    // by the way Study's targetLabels does).
    onTriggerRegen?: (key: string, targetLabels?: string[], force?: boolean) => Promise<{ status: "filled" | "empty" | "skipped" | "failed"; error?: string }>;
    saved?: boolean;
    saveError?: string | null;
    // W38 — the active subsection key, bound from the shell so a permalink can select it (and so
    // the shell can mirror it to the URL). Defaults to null → the fallback effect picks the first.
    active?: string | null;
    // M70/Phase 0 — a leaf's "Chat" action drops its permalink here, forwarded down to every
    // leaf-owning component so a later phase can wire real buttons.
    onStartChat?: (pl: Permalink) => void;
    // M75 — a sidebar row's "+" action, forwarded down so the matching leaf can auto-open its Add
    // flow once this instance mounts on the target tab/section.
    pendingSidebarAction?: { section?: string; verb: "new" | "add" } | null;
    onConsumeSidebarAction?: () => void;
    // M76/Phase 2-4 — the sidebar's lower-zone selection (see MarkersTab.svelte), and a deep-linked
    // anchor whose owning group may not be the active one, forwarded through to MarkersTab,
    // UnifiedTreatment, and FutureTreatment.
    activeGroup?: string | null;
    pendingAnchor?: string | null;
    onConsumeAnchor?: () => void;
    onNavigate?: (patch: Partial<Permalink>) => void;
    // M-chat-file-attach-and-create-note — a chat turn arrived here to seed a new note.
    pendingNoteAttachment?: NoteAttachment | null;
    onPendingNoteAttachmentConsumed?: () => void;
    // M-annotate — a leaf's "Annotate" action hands its permalink+preview here, forwarded down to
    // every leaf-owning component the same way onStartChat already is.
    onCreateNote?: (attachment: NoteAttachment) => void;
  }
  let {
    client, sections, clientId = null, providerSession = false,
    canTranslate = false, onTranslate, onCategorizeMarkers,
    vault, unitSystem, windowYears = $bindable(0), onToggleWatchlist, onTogglePinnedRatio,
    activeLeaf = null, onSave, onSaved, onTriggerRegen, saved = false, saveError = null,
    active = $bindable(null), onStartChat, pendingSidebarAction = null, onConsumeSidebarAction,
    activeGroup = $bindable(null), pendingAnchor = null, onConsumeAnchor,
    onNavigate, pendingNoteAttachment = null, onPendingNoteAttachmentConsumed, onCreateNote,
  }: Props = $props();

  let autoOpenAddThis = $derived(
    !!pendingSidebarAction &&
    pendingSidebarAction.verb === "add" && pendingSidebarAction.section === active,
  );

  let present = $derived(presentSections(client, sections).filter((s) => canSee(providerSession, client, s.key)));
  // Keep the active key valid as the client (and thus present sections) changes.
  $effect(() => {
    if (present.length > 0 && !present.some((s) => s.key === active)) active = present[0].key;
  });
  let activeKind = $derived(present.find((s) => s.key === active)?.kind);

  // W62 — the body cell's ★. Same pure mutation and same save path as the sidebar row's Pin
  // (App.svelte's sidebarTogglePin), so the two surfaces of one item cannot disagree about it.
  // Absent onSave (a read-only view) leaves onPin undefined and no star renders at all.
  const onPin: PinItem | undefined = onSave
    ? (kind, id) => onSave(togglePinnedIn(client, kind, id))
    : undefined;
</script>

{#if present.length === 0}
  <p class="sec-empty">Nothing here yet for {client.displayName}.</p>
{:else}
  {#if activeKind === "personalization"}
    <Personalization {client} {onSave} {saved} {saveError} />
  {:else if activeKind === "healthReports"}
    <HealthReports {client} {clientId} {onSave} {onSaved} {onTriggerRegen} {saved} {saveError} {onStartChat} {onCreateNote} bind:activeGroup {pendingAnchor} {onConsumeAnchor} {onPin} />
  {:else if activeKind === "treatment"}
    <UnifiedTreatment {client} {clientId} {onSave} {onSaved} {onTriggerRegen} {saved} {saveError} {onStartChat} {onCreateNote} autoOpenAdd={autoOpenAddThis} onAutoOpenAddConsumed={onConsumeSidebarAction} bind:activeGroup {pendingAnchor} {onConsumeAnchor} />
  {:else if activeKind === "markers"}
    {#if vault && unitSystem}
      <MarkersTab {vault} {client} {clientId} {unitSystem} bind:windowYears {onToggleWatchlist} {onTogglePinnedRatio} {canTranslate} {onTranslate} {onCategorizeMarkers} {onStartChat} {onCreateNote} bind:activeGroup {pendingAnchor} {onConsumeAnchor} />
    {/if}
  {:else if activeKind === "futureTreatment"}
    <FutureTreatment {client} {clientId} {onSave} {onSaved} {onTriggerRegen} {saved} {saveError} {onStartChat} {onCreateNote} autoOpenAdd={autoOpenAddThis} onAutoOpenAddConsumed={onConsumeSidebarAction} bind:activeGroup {pendingAnchor} {onConsumeAnchor} />
  {:else if activeKind === "analysis"}
    <Analysis {client} {activeGroup} {activeLeaf} {onPin} />
  {:else if activeKind === "study"}
    <Study {client} {clientId} {onSave} {onSaved} {onTriggerRegen} {saved} {saveError} {onStartChat} {onCreateNote} autoOpenAdd={autoOpenAddThis} onAutoOpenAddConsumed={onConsumeSidebarAction} />
  {:else if activeKind === "exploration"}
    <TestsToConsider {client} bind:activeGroup {pendingAnchor} {onConsumeAnchor} {onPin} />
  {:else if activeKind === "notes"}
    <!-- W63 — this is the ONLY mount for Questions, Recommended Markers and Glossary. Their
         own `activeKind` branches were deleted as unreachable: App.svelte's resolveNestedSection
         rewrites #client/docInference|healthMarkers|definitions to notes+group, and the fallback
         effect above cannot land on them either, since PRESENCE.notes is `() => true` and notes
         leads PATIENT_SECTION_ORDER, so present[0] is always Notes.
         Notes hosts Questions and Glossary as group rows, so the pane follows the sidebar selection
         the same way MarkersTab switches on activeGroup. Each is handed a neutral ALL_GROUP_KEY rather
         than the hosting group key: their own internal grouping compares against their own keys and
         would filter to nothing on an unrecognised one. -->
    {#if activeGroup === "docInference"}
      <QuestionsForDr {client} activeGroup={ALL_GROUP_KEY} {onPin} />
    {:else if activeGroup === "healthMarkers"}
    <RecommendedMarkers {client} {activeLeaf} {onPin} />
  {:else if activeGroup === "definitions"}
      <Glossary {client} activeGroup={ALL_GROUP_KEY} {onPin} />
    {:else}
    <Notes {client} {clientId} {onSave} {onSaved} {onTriggerRegen} {saved} {saveError} {onStartChat} {onCreateNote} autoOpenAdd={autoOpenAddThis} onAutoOpenAddConsumed={onConsumeSidebarAction} {onNavigate} pendingAttachment={pendingNoteAttachment} onPendingAttachmentConsumed={onPendingNoteAttachmentConsumed} />
    {/if}
  {:else if activeKind === "allergies"}
    <Allergies {client} {clientId} {onSave} {onSaved} {onTriggerRegen} {saved} {saveError} {onStartChat} {onCreateNote} autoOpenAdd={autoOpenAddThis} onAutoOpenAddConsumed={onConsumeSidebarAction} />
  {:else if activeKind === "familyHistory"}
    <Family {client} {clientId} {onSave} {onSaved} {onTriggerRegen} {saved} {saveError} {onStartChat} {onCreateNote} autoOpenAdd={autoOpenAddThis} onAutoOpenAddConsumed={onConsumeSidebarAction} />
  {/if}
{/if}

<style>
  .sec-empty { color: var(--muted); font-style: italic; padding: 1rem 0; }
  @media print { .sec-empty { display: none !important; } }
</style>

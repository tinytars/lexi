<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Client, Vault } from "./types";
  import type { UnitSystem } from "./units";
  import { DEFAULT_PERSONA, PERSONAS, type PersonaId } from "./personas";
  import { isSpeechSupported, speechRegistry } from "@tinytars/frame/speech-registry.svelte";
  import type { RefreshStage } from "./finding-refresh";
  import type { RefreshProgress } from "./refresh-client";
  import { SECTION_TAB, type Permalink } from "./permalink";
  import { TABS, type Tab } from "./nav";
  import { canSee } from "./visibility";
  import { PATIENT_SECTIONS, AI_SECTIONS, presentSections, type SectionMeta } from "./report-sections";
  import { sidebarActionFor, type SidebarVerb } from "./sidebar-actions";
  import { loadSidebarMode, saveSidebarMode, modeForSection, type SidebarMode } from "./sidebar-mode";
  import { loadLastSection } from "./nav-memory";
  import SidebarGroupList from "@tinytars/frame/SidebarGroupList.svelte";
  import SidebarLeafList from "@tinytars/frame/SidebarLeafList.svelte";
  import type { SidebarGroupRow, SidebarLeafRow } from "@tinytars/frame/sidebar-rows";
  import { todayISODate } from "@pablotech/akesi/treatment-bucket";
  import { lowerZoneKindFor, lowerZoneModel } from "./sidebar-lower-zone";
  import { sortThreads, type Thread } from "./chat-threads";
  import { threadLeaf } from "./sidebar-leaf-mappers";
  import { ALL_GROUP_LABEL, ALL_GROUP_KEY } from "./sidebar-labels";
  import { ANALYSIS_NAV } from "./analysis-nav";
  import { analysisSidebarGroups } from "./analysis-items";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { capabilitiesFor, capabilitiesForRow, type RowCapabilities, type RowKind } from "./sidebar-row-capabilities";
import { pinnedQueries } from "@pablotech/akesi/pinned-queries";
  import type { SidebarItemKind } from "./vault-item-ops";

  interface Props {
    activeTab: Tab;
    client: Client | null;
    providerSession: boolean;
    active: string | null;
    activeGroup: string | null;
    expanded?: boolean;
    mobileOpen?: boolean;
    onNavigate: (patch: Partial<Permalink>) => void;
    onAction: (key: string, verb: SidebarVerb) => void;
    onSelectGroup: (key: string) => void;
    // W62 — the child row that was clicked, so a section whose children are its cells can filter to
    // it (group-filter.ts's filterByLeaf). Sections that do not filter by leaf simply never read it.
    onSelectLeafKey?: (key: string | null) => void;
    // M76 Phase 5 — Assistant's thread list, reusing `active` (App.svelte's `section`) as the
    // active thread id; chat has no separate "group" concept.
    threads: Thread[];
    renamingId: string | null;
    renameText: string;
    onSelectThread: (id: string) => void;
    onTogglePinThread: (id: string) => void;
    onDeleteThread: (id: string) => void;
    onCommitRename: () => void;
    // W61 — the sidebar's own per-row actions, applied by App through vault-item-ops + saveEdits.
    onSidebarTogglePin?: (kind: SidebarItemKind, id: string) => void;
    onSidebarRename?: (kind: SidebarItemKind, id: string, text: string) => void;
    onSidebarDelete?: (kind: SidebarItemKind, id: string, label: string) => void;
    sidebarLabelOf?: (kind: SidebarItemKind, id: string) => string;
    // M91 Phase 2 — the Search nav row (replaces M85's persistent sidebar input; the search box
    // itself now lives in the center-panel SearchPanel).
    searchOpen?: boolean;
    onOpenSearch?: () => void;
    // M104 — the Search row's own "+" action (mirrors the Chat/section rows' side-row-action
    // convention below): starts a fresh search instead of resuming the last query/results.
    onFreshSearch?: () => void;
    windowYears?: number;
    // M78 Phase 8 — the account pulldown, rendered in a fixed (non-scrolling) area at the bottom of
    // the sidebar. Sidebar.svelte only owns the layout — App.svelte keeps owning AccountMenu's
    // callback wiring by passing it as a snippet.
    accountArea?: Snippet;
    // M93 — the account-level measurement-system toggle, always visible above the account
    // pulldown (a rushed doctor doesn't hunt for a settings field). Only rendered alongside
    // accountArea — the pre-vault login/roster screens pass neither.
    unitSystem?: UnitSystem;
    onSetUnitSystem?: (s: UnitSystem) => void;
    persona?: PersonaId;
    onSetPersona?: (p: PersonaId) => void;
    // M78 Phase 10 — brand + patient/family switcher, a fixed (non-scrolling) area at the top of
    // the sidebar, moved verbatim from the header.
    productName?: string;
    vault?: Vault | null;
    selectedClientId?: string | null;
    // M78 Phase 11 — the provider-only refresh/"Generating…" status, likewise moved verbatim.
    providerToken?: string | null;
    refreshing?: boolean;
    refreshProgress?: RefreshProgress | null;
    refreshStage?: RefreshStage | null;
    refreshError?: string | null;
    onCancelRefresh?: () => void;
    onDismissRefreshError?: () => void;
    // W70 — a save started from a sidebar row (delete / rename / pin) applies OPTIMISTICALLY and then
    // fires a queued PUT. Until now `saveError` was passed only to ReportSections, so a failed sidebar
    // delete showed the row already gone, reported the failure inside a section editor the user may
    // not have been looking at, and then erased it on the next edit. The error belongs where the
    // action was taken.
    saveError?: string | null;
    onRetrySave?: () => void;
    // M78 Phase 12 — the "Some sections out of date" badge, likewise moved verbatim.
    findingStale?: boolean;
    onOpenDag?: () => void;
  }
  let {
    activeTab, client, providerSession, active, activeGroup,
    expanded = $bindable(true), mobileOpen = $bindable(false), onNavigate, onAction, onSelectGroup, onSelectLeafKey,
    threads, renamingId = $bindable(null), renameText = $bindable(""),
    onSelectThread, onTogglePinThread, onDeleteThread, onCommitRename,
    onSidebarTogglePin, onSidebarRename, onSidebarDelete, sidebarLabelOf,
    searchOpen = false,
    onOpenSearch,
    onFreshSearch,
    windowYears = $bindable(1),
    accountArea,
    unitSystem = "imperial", onSetUnitSystem, persona = DEFAULT_PERSONA, onSetPersona,
    productName = "", vault = null, selectedClientId = null,
    providerToken = null, refreshing = false, refreshProgress = null, refreshStage = null, refreshError = null,
    saveError = null, onRetrySave = undefined,
    onCancelRefresh, onDismissRefreshError,
    findingStale = false, onOpenDag,
  }: Props = $props();

  // M78 Phase 10 — moved verbatim from App.svelte's own clientList().
  function clientList(v: Vault): [string, Client][] {
    return Object.entries(v.clients).sort((a, b) => a[1].displayName.localeCompare(b[1].displayName));
  }

  const SAMPLE_ID = "persona-sample";
  let lowerZoneKind = $derived(lowerZoneKindFor(activeTab, active));
  // W48 — Profile's own group list is real navigation (Bio/Allergies/Family are three distinct
  // top-level section keys), not an in-page filter — its render branch below wires onSelect to
  // selectRow directly instead of onSelectGroup, and activeKey to `active` instead of `activeGroup`.
  // W61 — per-row Pin/Rename/Delete for the sections whose items have a vault record. Which
  // sections those are, and which actions each offers, is the one table in
  // sidebar-row-capabilities.ts; a section absent from it gets no menu and no ★, which is how
  // Markers/Reports/Questions/Glossary/Exploration stay action-free until they have records.
  // ONE inline-rename state for every section, threads included — renamingId/renameText are the
  // bindable pair App already owns (ChatTab's header Rename targets the open thread through them).
  // A second, parallel rename state for vault items would have been the same duplication this
  // milestone exists to remove.
  // W62 — how many areas of query the user has starred. Drives the notice below the group list;
  // pinnedQueries is the same function the prompt and the staleness hash read, so the number shown
  // is exactly the number that goes into the inference.
  let pinnedCount = $derived(client ? pinnedQueries(client).length : 0);

  let itemRenameKind = $state<RowKind | null>(null);
  let itemRenameId = $state<string | null>(null);

  // W62 — one call. Treatment's medicine/dose split, Markers' ratio/level split and the three
  // foreign sections Notes hosts (Questions/Markers/Glossary) are all group-dependent, and every
  // one of them now resolves inside capabilitiesForRow instead of as a branch here.
  function capsFor(groupKey?: string): RowCapabilities | null {
    if (lowerZoneKind === "chat") return capabilitiesFor("chat");
    // Allergies/Family are their own section keys, not a lowerZoneKind.
    return capabilitiesForRow(lowerZoneKind === "personalization" ? active : lowerZoneKind, groupKey);
  }

  // `itemId` names the vault record when the row's own key isn't it (Hypothesis keys positionally,
  // because that is what its anchor needs); `null` means the row has no record at all — an
  // AI-proposed idea — so it gets no ★ and no menu.
  function recordIdOf(row: SidebarLeafRow): string | null {
    return row.itemId === undefined ? row.key : row.itemId;
  }

  function rowPinFor(row: SidebarLeafRow, groupKey?: string) {
    const caps = capsFor(groupKey);
    const id = recordIdOf(row);
    if (!caps?.pin || !id) return null;
    if (caps.kind === "thread") return { pinned: !!row.pinned, onTogglePin: () => onTogglePinThread(id) };
    if (!onSidebarTogglePin) return null;
    return { pinned: !!row.pinned, onTogglePin: () => onSidebarTogglePin(caps.kind as SidebarItemKind, id) };
  }

  function rowActions(row: SidebarLeafRow, groupKey?: string): LeafMenuItem[] {
    const caps = capsFor(groupKey);
    const id = recordIdOf(row);
    if (!caps || !id) return [];
    const isThread = caps.kind === "thread";
    const items: LeafMenuItem[] = [];
    if (caps.rename && (isThread || onSidebarRename)) {
      items.push({ label: "Rename", onClick: () => {
        itemRenameKind = caps.kind;
        itemRenameId = id;
        renamingId = row.key;
        renameText = (isThread ? row.label : sidebarLabelOf?.(caps.kind as SidebarItemKind, id)) || row.label;
      } });
    }
    if (caps.delete && (isThread || onSidebarDelete)) {
      items.push({
        label: "Delete",
        danger: true,
        onClick: () => (isThread ? onDeleteThread(id) : onSidebarDelete!(caps.kind as SidebarItemKind, id, row.label)),
      });
    }
    return items;
  }

  // One commit, dispatched by kind: a thread goes through App's chat rename, everything else
  // through the vault ops.
  function commitItemRename() {
    if (itemRenameKind === "thread") onCommitRename();
    else if (itemRenameId && itemRenameKind) onSidebarRename?.(itemRenameKind as SidebarItemKind, itemRenameId, renameText);
    renamingId = null;
    itemRenameKind = null;
    itemRenameId = null;
  }

  // Chat's single All group. sortThreads already floats pinned first, so the children arrive in the
  // same order the rest of the sidebar's builders now produce (sortPinnedFirst).
  let chatGroupRows = $derived<SidebarGroupRow[]>([{
    key: ALL_GROUP_KEY,
    label: ALL_GROUP_LABEL,
    count: threads.length,
    defaultExpanded: true,
    children: sortThreads(threads).map(threadLeaf),
  }]);

  let analysisGroupRows = $derived<SidebarGroupRow[]>(client ? analysisSidebarGroups(client) : []);

  let lowerZone = $derived(lowerZoneModel(lowerZoneKind, client, active, todayISODate(), onAction));
  let lowerGroupRows = $derived(lowerZone.groupRows);
  let lowerGroupPendingNote = $derived(lowerZone.pendingNote);
  let lowerLeafRows = $derived(lowerZone.leafRows);
  // M82 Phase 3 — a group's visible rows: filters each group's SectionMeta[] by presence + audience,
  // the same predicates the old per-tab sectionsFor used.
  function visibleSections(sections: SectionMeta[]): SectionMeta[] {
    if (!client) return [];
    return presentSections(client, sections).filter((s) => canSee(providerSession, client, s.key));
  }
  // W48 — Allergies/Family are still valid PATIENT_SECTIONS members (mode classification,
  // permalinks, visibility toggles all still work), but no longer their own flat top-level rows —
  // they render only inside Profile's own lower-zone group list (Bio/Allergies/Family) below.
  // docInference/definitions join allergies/familyHistory as sections that exist but are not flat
  // rows: Questions and Glossary now render as group rows inside Notes.
  const NESTED_SECTIONS = new Set(["allergies", "familyHistory", "docInference", "healthMarkers", "definitions"]);
  let patientRows = $derived(visibleSections(PATIENT_SECTIONS).filter((s) => !NESTED_SECTIONS.has(s.key)));
  let investigatorRows = $derived(visibleSections(AI_SECTIONS));
  let showToggle = $derived(investigatorRows.length > 0);
  let sidebarMode = $state<SidebarMode>(loadSidebarMode());
  // M105 — flipping the toggle also jumps the main pane to whatever section was last visited in
  // the new mode on this client, instead of only relabeling the sidebar's row list.
  function setSidebarMode(m: SidebarMode) {
    sidebarMode = m;
    saveSidebarMode(m);
    const remembered = loadLastSection(selectedClientId, m);
    if (remembered && remembered !== active) {
      onNavigate({ tab: SECTION_TAB[remembered], section: remembered });
    }
  }

  $effect(() => {
    const m = modeForSection(active);
    if (m) sidebarMode = m;
  });

  // M82 Phase 3 — single handler for every flat nav row (Assistant + every Patient/Investigator
  // section row), replacing the deleted selectTab/selectSection. Assistant (no SectionMeta of its
  // own) passes its last-known thread id, same as the old whole-tab click did.
  function selectRow(tabId: Tab, key?: string) {
    onNavigate({ tab: tabId, section: key });
    mobileOpen = false;
  }
  // M78 Phase 2 — a leaf-list row click scrolls to that item in the body (never a view switch).
  function selectLeaf(tabId: Tab, key: string, anchor: string) {
    onNavigate({ tab: tabId, section: key, anchor });
    mobileOpen = false;
  }
  // M76 Phase 5 — mirrors selectSection's "close the mobile drawer after acting on it" convention.
  function selectThreadAndClose(id: string) {
    onSelectThread(id);
    mobileOpen = false;
  }
</script>

{#if mobileOpen}
  <button class="sidebar-scrim" aria-label="Close menu" onclick={() => (mobileOpen = false)}></button>
{/if}
<nav class="sidebar" class:rail={!expanded} class:open={mobileOpen} aria-label="Sections">
  <div class="sidebar-top">
    <div class="sidebar-top-row">
      <div class="brand">{productName}</div>
      <button class="sidebar-collapse" onclick={() => (expanded = !expanded)}
              aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}>{expanded ? "«" : "»"}</button>
    </div>
    {#if vault && Object.keys(vault.clients).length > 1}
      <nav class="patient-switcher" aria-label="Patient">
        <button class:active={selectedClientId === null} onclick={() => onNavigate({ client: undefined, section: undefined, anchor: undefined })}>Family</button>
        {#each clientList(vault) as [id, c] (id)}
          <button class:active={id === selectedClientId} onclick={() => onNavigate({ client: id, section: undefined, anchor: undefined })}>{c.displayName}</button>
        {/each}
      </nav>
    {/if}
    {#if providerSession && client && providerToken && refreshing}
      <div class="refresh-status" class:busy={refreshing} title="The Translation is being generated — this takes a few minutes">
        <!-- W65 — two phases now: the streamed core (portion bar), then one leaf at a time. The
             stage line names the leaf so a long run reads as progress rather than a stalled bar. -->
        <span class="beachball" aria-hidden="true"></span>
        {refreshStage && refreshStage.index > 0 ? refreshStage.label : "Generating…"}
        {#if refreshStage && refreshStage.index > 0}
          <span class="refresh-bar" aria-hidden="true"><span class="refresh-bar-fill" style="width:{(refreshStage.index / refreshStage.total) * 100}%"></span></span>
        {:else if refreshProgress}
          <span class="refresh-bar" aria-hidden="true"><span class="refresh-bar-fill" style="width:{(refreshProgress.received / refreshProgress.total) * 100}%"></span></span>
        {:else}starting…{/if}
        <button class="refresh-cancel" title="Stop generating now (avoids further cost)" onclick={onCancelRefresh}>✕ Cancel</button>
      </div>
    {/if}
    {#if refreshError}
      <button class="refresh-err" title={refreshError} onclick={onDismissRefreshError}>translation failed ✕</button>
    {/if}
    {#if saveError}
      <!-- Same visual idiom as the refresh error above — one banner concept, not two. Offers RETRY
           rather than dismiss: the change is already applied in memory and is not yet on the server,
           so dismissing would hide an unsaved edit rather than resolve it. -->
      <button class="refresh-err" title={saveError} onclick={onRetrySave}>save failed — retry ↻</button>
    {/if}
  </div>
  <div class="sidebar-scroll">
  <div class="nav-list">
    {#if showToggle}
      <div class="mode-toggle" role="tablist" aria-label="Sidebar section group">
        <button role="tab" data-testid="mode-patient" aria-selected={sidebarMode === "patient"} class:active={sidebarMode === "patient"}
                onclick={() => setSidebarMode("patient")}>Patient</button>
        <button role="tab" data-testid="mode-investigator" aria-selected={sidebarMode === "investigator"} class:active={sidebarMode === "investigator"}
                onclick={() => setSidebarMode("investigator")}>Investigator</button>
      </div>
    {/if}
    <!-- M104 — searchOpen and activeTab/active track independently, so every other row's own
         active check below is also gated on !searchOpen: otherwise the previously-active tab/
         section stays visually highlighted at the same time as Search. -->
    <div class="side-row" class:active={searchOpen}>
      {#if onFreshSearch}
        <button class="side-row-action" title="Start a fresh search" aria-label="Start a fresh search"
                onclick={(e) => { e.stopPropagation(); onFreshSearch(); mobileOpen = false; }}>+</button>
      {:else}
        <span class="side-row-gutter" aria-hidden="true"></span>
      {/if}
      <button class="nav-item" data-testid="nav-search" class:active={searchOpen} title="Search across your record"
              onclick={() => { onOpenSearch?.(); mobileOpen = false; }}>
        <span class="side-icon" aria-hidden="true">🔎</span><span class="nav-label">Search</span>
      </button>
    </div>
    {#if canSee(providerSession, client, "chat")}
      {@const chatTab = TABS.find((t) => t.id === "chat")!}
      {@const chatAction = sidebarActionFor("chat")}
      <div class="side-row" class:active={activeTab === "chat" && !searchOpen}>
        {#if chatAction}
          <button class="side-row-action" title={chatAction.label} aria-label={chatAction.label}
                  onclick={(e) => { e.stopPropagation(); onAction("chat", chatAction.verb); }}>+</button>
        {:else}
          <span class="side-row-gutter" aria-hidden="true"></span>
        {/if}
        <button class="nav-item" data-testid="nav-chat" class:active={activeTab === "chat" && !searchOpen}
                title={chatTab.blurb} onclick={() => selectRow("chat", undefined)}>
          <span class="side-icon" aria-hidden="true">{chatTab.icon}</span><span class="nav-label">{chatTab.label}</span>
        </button>
      </div>
    {/if}
    {#each (showToggle && sidebarMode === "investigator" ? investigatorRows : patientRows) as s (s.key)}
      {@const rowAction = sidebarActionFor(s.key)}
      <div class="side-row" class:active={active === s.key && !searchOpen}>
        {#if rowAction}
          <button class="side-row-action" title={rowAction.label} aria-label={rowAction.label}
                  onclick={(e) => { e.stopPropagation(); onAction(s.key, rowAction.verb); }}>+</button>
        {:else}
          <span class="side-row-gutter" aria-hidden="true"></span>
        {/if}
        <button class="nav-item" data-testid="nav-{s.key}" class:active={active === s.key && !searchOpen}
                title={s.blurb} onclick={() => selectRow(SECTION_TAB[s.key], s.key)}>
          <span class="side-icon" aria-hidden="true">{s.icon}</span><span class="nav-label">{s.label}</span>
        </button>
      </div>
    {/each}
  </div>
  {#if lowerZoneKind}
  <!-- W58 — remounts SidebarGroupList fresh on every section switch, so a row's expand/collapse
       $state (keyed by r.key, e.g. ALL_GROUP_KEY reused across Markers/Questions/Reports/etc.)
       never leaks from one section into an unrelated one that happens to share a key. -->
  {#key lowerZoneKind}
    <hr class="side-divider" />
    {#if lowerZoneKind === "chat"}
      <!-- Chat is a caller like every other section now: one All group whose children are the
           threads. It used to be ChatThreadList, a hand-rolled copy of this component that had
           drifted to a smaller label, no child indent and its own rail rule. -->
      <SidebarGroupList
        rows={chatGroupRows}
        activeKey={activeGroup}
        onSelect={onSelectGroup}
        activeChildKey={active}
        onSelectChild={(row) => selectThreadAndClose(row.key)}
        childActions={rowActions}
        childPinFor={rowPinFor}
        bind:renamingKey={renamingId}
        bind:renameText
        onCommitRename={commitItemRename}
      />
    {:else if lowerZoneKind === "healthReports"}
      <!-- W58 — each group's own reports live on its row's `children` now (see
           reportSidebarGroups); no separate flat leaf list beneath. -->
      <!-- Two-arg onSelectChild (the form the markers branch already used): activate the child's
           own group FIRST, then scroll. Without it, clicking a Questions/Recommended-Markers/Glossary
           child while Notes-All was showing navigated to an anchor that is not in the DOM —
           flashAnchor retried eight times and silently gave up. -->
      <SidebarGroupList rows={lowerGroupRows} activeKey={activeGroup} onSelect={onSelectGroup}
                        onSelectChild={(row, groupKey) => { onSelectGroup(groupKey); onSelectLeafKey?.(row.key); selectLeaf(activeTab, lowerZoneKind, row.anchor); }}
                        childActions={rowActions} childPinFor={rowPinFor}
                        bind:renamingKey={renamingId} bind:renameText
                        onCommitRename={commitItemRename} />
    {:else if lowerZoneKind === "analysis"}
      <!-- W61 — Analysis lists its ITEMS now, like every other section: an All row over every
           LexiTar turn, then one row per block. The page renders every block at once, so a group
           row click scrolls to that block's heading rather than narrowing the view. -->
      <SidebarGroupList
        rows={analysisGroupRows}
        activeKey={activeGroup}
        onSelect={(key) => {
          const nav = ANALYSIS_NAV.find((n) => n.key === key);
          onSelectGroup(key);
          if (nav) selectLeaf(activeTab, lowerZoneKind, nav.anchor);
        }}
        onSelectChild={(row) => { onSelectLeafKey?.(row.key); selectLeaf(activeTab, lowerZoneKind, row.anchor); }}
        childActions={rowActions}
        childPinFor={rowPinFor}
      />
    {:else if lowerZoneKind === "notes" || lowerZoneKind === "study"}
      <!-- W58 — each group's own items live on its row's `children` now (see
           notesSidebarGroups/studySidebarGroups); no separate flat leaf list beneath. -->
      <!-- Two-arg onSelectChild (the form the markers branch already used): activate the child's
           own group FIRST, then scroll. Without it, clicking a Questions/Recommended-Markers/Glossary
           child while Notes-All was showing navigated to an anchor that is not in the DOM —
           flashAnchor retried eight times and silently gave up. -->
      <SidebarGroupList rows={lowerGroupRows} activeKey={activeGroup} onSelect={onSelectGroup}
                        onSelectChild={(row, groupKey) => { onSelectGroup(groupKey); onSelectLeafKey?.(row.key); selectLeaf(activeTab, lowerZoneKind, row.anchor); }}
                        childActions={rowActions} childPinFor={rowPinFor}
                        bind:renamingKey={renamingId} bind:renameText
                        onCommitRename={commitItemRename} />
    {:else if lowerZoneKind === "personalization"}
      <!-- W48 — real navigation, not an in-page filter: Bio/Allergies/Family are three distinct
           top-level section keys, so activeKey/onSelect target `active`/selectRow directly instead
           of the activeGroup/onSelectGroup pair every other SidebarGroupList caller here uses. -->
      <SidebarGroupList rows={lowerGroupRows} activeKey={active} onSelect={(key) => selectRow(SECTION_TAB[key], key)} />
      {#if lowerLeafRows.length > 0}
        <SidebarLeafList
          rows={lowerLeafRows}
          onSelect={(row) => selectLeaf(activeTab, active!, row.anchor)}
          actions={rowActions}
          pinFor={rowPinFor}
          bind:renamingKey={renamingId}
          bind:renameText
          onCommitRename={commitItemRename}
        />
      {/if}
    {:else}
      {#if lowerZoneKind === "markers"}
        <div class="markers-controls">
          <!-- W70 — axe flagged this CRITICAL (select-name): the only <select> in the app with no
               accessible name, so a screen-reader user hears "combo box" with no idea it controls the
               time window the charts are drawn over. -->
          <select class="dropdown" aria-label="Time window for marker charts" bind:value={windowYears}>
            <option value={0.25}>3 months</option>
            <option value={0.5}>6 months</option>
            <option value={1}>1 year</option>
            <option value={5}>5 years</option>
            <option value={10}>10 years</option>
            <option value={Infinity}>All time</option>
          </select>
        </div>
      {/if}
      <!-- Selecting the child's own group first: Treatment defaults to All (which already shows
           every drug), so its leaf has nothing to reverse-match and would otherwise leave you in
           All after clicking a child listed under Ongoing. -->
      <SidebarGroupList rows={lowerGroupRows} activeKey={activeGroup} pendingNote={lowerGroupPendingNote} onSelect={onSelectGroup}
                        onSelectChild={(row, groupKey) => { onSelectGroup(groupKey); onSelectLeafKey?.(row.key); selectLeaf(activeTab, lowerZoneKind, row.anchor); }}
                        childActions={rowActions} childPinFor={rowPinFor}
                        bind:renamingKey={renamingId} bind:renameText
                        onCommitRename={commitItemRename} />
    {/if}
  {/key}
  {/if}
  </div>
  <!-- W62 — pinning is NOT silent. A star changes what the next Translation is asked to look into,
       and the owner's rule is that the user must be told that, not left to infer it. This sits with
       the stale badge because they answer the same question: what state is the Translation in, and
       what did I do to it? -->
  {#if client && pinnedCount > 0}
    <div class="pinned-note" title="Starred items are read as AREAS OF QUERY — they tell {productName} what to look into. They are never treated as evidence, findings, or health record; every statement still comes from your markers, reports and notes.">
      ★ {pinnedCount} starred {pinnedCount === 1 ? "item" : "items"} steer the next Translation
    </div>
  {/if}
  {#if client && findingStale}
    <button class="stale-badge" title="Some sections were generated from older inputs — see the ● chips on each section. Inspect what changed in the Translation DAG." onclick={onOpenDag}>Some sections out of date</button>
  {/if}
  {#if accountArea}
    <div class="sidebar-account">
      {#if onSetUnitSystem}
        <div class="unit-toggle" role="group" aria-label="Measurement system">
          <button type="button" title="US units (lb, mg/dL)" class:active={unitSystem === "imperial"}
            onclick={() => onSetUnitSystem("imperial")}>US</button>
          <button type="button" title="Metric units (kg, mmol/L)" class:active={unitSystem === "metric"}
            onclick={() => onSetUnitSystem("metric")}>Metric</button>
        </div>
      {/if}
      {#if onSetPersona}
        <div class="unit-toggle" role="group" aria-label="Who answers">
          {#each Object.values(PERSONAS) as p (p.id)}
            <button type="button" title={p.blurb} class:active={persona === p.id} aria-pressed={persona === p.id}
              onclick={() => onSetPersona(p.id)}>{p.name}</button>
          {/each}
          {#if isSpeechSupported()}
            <button type="button" title="Hear {PERSONAS[persona].name}" aria-label="Hear {PERSONAS[persona].name}"
              class:active={speechRegistry.statusOf(SAMPLE_ID) === "playing"}
              onclick={() => speechRegistry.toggle(SAMPLE_ID, PERSONAS[persona].sample, PERSONAS[persona].name, persona)}>&#9654;&#xFE0E;</button>
          {/if}
        </div>
      {/if}
      {@render accountArea()}
    </div>
  {/if}
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 280px;
    flex: 0 0 280px;
    border-right: 1px solid var(--border);
    background: white;
    box-sizing: border-box;
  }
  .sidebar.rail { width: 72px; flex-basis: 72px; }
  /* M78 Phase 8 — the scrollable middle (tabs + lower zone), split out so the account area below
     can stay fixed at the bottom instead of scrolling away with the tab list. */
  .sidebar-scroll {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    flex: 1 1 auto;
    min-height: 0;
    padding: 0.5rem;
    box-sizing: border-box;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .sidebar.rail .sidebar-scroll { align-items: center; }
  .sidebar-account {
    flex: none;
    border-top: 1px solid var(--border);
    padding: 0.5rem;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .sidebar.rail .sidebar-account { align-items: center; }
  .sidebar.rail .unit-toggle { display: none; }
  /* M93 — always-visible US|Metric toggle, above the account pulldown. */
  .unit-toggle { display: flex; border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
  .unit-toggle button {
    flex: 1; padding: 0.3rem 0.6rem; border: none; background: white; font: inherit; font-size: 0.8rem;
    cursor: pointer; color: var(--muted);
  }
  .unit-toggle button.active { background: var(--accent); color: white; }

  /* M78 Phase 10 — brand + patient/family switcher, a fixed top area moved from the old header. */
  .sidebar-top {
    flex: none;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--border);
    box-sizing: border-box;
  }
  .sidebar.rail .sidebar-top { padding: 0.6rem 0.4rem; }
  .sidebar-top-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .sidebar.rail .sidebar-top-row { justify-content: center; }
  .brand { font-weight: 600; }
  .sidebar.rail .brand { display: none; }
  .patient-switcher { display: flex; flex-direction: column; gap: 0.25rem; margin-top: 0.5rem; }
  .sidebar.rail .patient-switcher { display: none; }
  .patient-switcher button {
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); background: white; border-radius: 6px;
    font: inherit; font-size: 0.85rem; cursor: pointer; min-height: 36px; text-align: left;
  }
  .patient-switcher button.active { border-color: var(--accent); color: var(--accent); }

  .mode-toggle {
    display: flex; gap: 2px; margin: 0.35rem 0.75rem 0.5rem; padding: 3px;
    background: color-mix(in srgb, var(--border) 60%, transparent); border-radius: 999px;
  }
  .mode-toggle button {
    flex: 1; border: none; background: none; border-radius: 999px;
    padding: 0.4rem 0.5rem; font: inherit; font-size: 0.8rem; font-weight: 600;
    color: var(--muted); cursor: pointer; min-height: 32px;
  }
  .mode-toggle button.active { background: var(--accent); color: var(--surface); }

  /* M92 — moved to sit directly above .sidebar-account (was under the brand, M78 Phase 12). */
  .pinned-note {
    margin: 0.35rem 0.5rem 0;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.72rem;
    line-height: 1.35;
  }
  .sidebar.rail .pinned-note { display: none; }
  .stale-badge {
    display: block; flex: none; width: auto; box-sizing: border-box; margin: 0.5rem;
    font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    text-align: left; color: var(--warn); background: var(--warn-band); border: 1px solid var(--warn);
    border-radius: 6px; padding: 0.3rem 0.55rem; cursor: pointer; font-family: inherit;
  }
  .sidebar.rail .stale-badge { display: none; }
  @media (max-width: 640px) {
    .sidebar.rail .stale-badge { display: block; }
  }

  /* M78 Phase 11 — the provider-only refresh/"Generating…" status, moved from the header. */
  .refresh-status {
    display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap;
    margin-top: 0.5rem; padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    font-size: 0.8rem; color: var(--muted);
  }
  .refresh-status.busy { color: var(--accent); border-color: var(--accent); cursor: progress; font-variant-numeric: tabular-nums; }
  .refresh-cancel {
    margin-left: auto; border: none; background: none; color: inherit; font: inherit; font-size: 0.78rem;
    cursor: pointer; padding: 0.1rem 0.3rem;
  }
  .refresh-cancel:hover { color: var(--accent); }
  .refresh-err {
    display: block; width: 100%; box-sizing: border-box; margin-top: 0.5rem; padding: 0.35rem 0.6rem;
    border: 1px solid var(--alert); border-radius: 6px; background: white; color: var(--alert);
    font: inherit; font-size: 0.8rem; cursor: pointer; text-align: left;
  }
  .refresh-bar {
    display: inline-block; width: 2.5em; height: 0.5em; vertical-align: -0.05em; margin: 0 0.2em;
    border-radius: 3px; background: color-mix(in srgb, var(--accent) 20%, transparent); overflow: hidden;
  }
  .refresh-bar-fill { display: block; height: 100%; background: var(--accent); transition: width 0.3s ease; }
  .beachball {
    display: inline-block; width: 0.8em; height: 0.8em; vertical-align: -0.05em; margin-right: 0.2em;
    border: 2px solid color-mix(in srgb, var(--accent) 35%, transparent); border-top-color: var(--accent);
    border-radius: 50%; animation: beachspin 0.7s linear infinite;
  }
  @keyframes beachspin { to { transform: rotate(360deg); } }
  @media (max-width: 640px) {
    .sidebar.rail .brand { display: block; }
    .sidebar.rail .patient-switcher { display: flex; }
    .sidebar.rail .refresh-status, .sidebar.rail .refresh-err { display: flex; }
  }
  .sidebar.rail .refresh-status, .sidebar.rail .refresh-err { display: none; }

  .sidebar-collapse {
    flex: none;
    border: none; background: none; color: var(--muted); cursor: pointer; font: inherit;
    padding: 0.35rem 0.6rem; min-height: 36px;
  }
  /* M82 Phase 3 — one flat list (Assistant + every section row); rail mode hides the whole
     container instead of hiding labels/actions on each row. M83 — Patient/Investigator now share
     this list behind the .mode-toggle below. */
  .nav-list { display: flex; flex-direction: column; gap: 0.15rem; }
  .sidebar.rail .nav-list { display: flex; align-items: center; }
  .nav-item {
    display: flex; align-items: center; gap: 0.6rem; flex: 1 1 auto; min-width: 0;
    padding: 0.6rem 0.75rem; border: none; background: none;
    font: inherit; font-size: 0.92rem; color: var(--muted); cursor: pointer; min-height: 44px;
    text-align: left;
  }
  .sidebar.rail .nav-item { justify-content: center; gap: 0; padding: 0.6rem 0; }
  .nav-item.active { color: var(--accent); font-weight: 600; }
  .sidebar.rail .nav-label { display: none; }
  .side-icon { font-size: 1.1rem; flex-shrink: 0; }
  .sidebar-scrim { display: none; }

  /* M84 — the "+" (or its gutter placeholder) and the label share one highlight, so every row's
     label starts at the same x-offset whether or not it has a "+", and hovering/activating a row
     lights the "+" and the text as one pill instead of two independently-lit rectangles. */
  .side-row { display: flex; align-items: center; gap: 0.15rem; border-radius: 8px; }
  .side-row:hover .nav-item { color: var(--fg); }
  .side-row:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
  .side-row.active { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .side-row-gutter { flex-shrink: 0; display: inline-block; width: 36px; height: 36px; }
  /* M86 Phase 0 — "+" is a visually distinct chip at rest, not just on hover, so it reads as its
     own actionable control separate from the row label. */
  .side-row-action {
    flex-shrink: 0; border: none; background: var(--band); color: var(--accent); cursor: pointer;
    font: inherit; font-size: 1.15rem; line-height: 1; padding: 0.4rem 0.5rem; border-radius: 6px;
    min-height: 36px; min-width: 36px;
  }
  .side-row:hover .side-row-action { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .sidebar.rail .side-row-action { display: none; }
  .sidebar.rail .side-row-gutter { display: none; }

  .side-divider { border: none; border-top: 1px solid var(--border); margin: 0.5rem 0.75rem; }
  .sidebar.rail .side-divider { display: none; }

  /* M78 Phase 4 — Markers' controls, moved here verbatim from MarkersTab.svelte's center panel. */
  .markers-controls {
    display: flex; flex-direction: column; gap: 0.5rem;
    padding: 0 0.75rem 0.5rem;
  }
  .sidebar.rail .markers-controls { display: none; }
  .markers-controls .dropdown {
    padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 999px;
    background: white; font: inherit; font-size: 0.85rem; color: var(--fg); cursor: pointer;
    min-height: 40px; width: 100%;
  }
  .markers-controls .dropdown:focus { outline: none; border-color: var(--accent); }
  @media (max-width: 640px) {
    .sidebar.rail .markers-controls { display: flex; }
  }

  @media (min-width: 641px) {
    .sidebar { position: sticky; top: var(--shell-top); height: calc(100vh - var(--shell-top)); }
  }

  @media (max-width: 640px) {
    .sidebar-collapse { display: none; }
    .sidebar-top { padding-left: 3.25rem; }
    .sidebar {
      position: fixed; top: var(--shell-top); left: 0; bottom: 0; z-index: 30;
      width: 260px; flex-basis: auto;
      transform: translateX(-105%); transition: transform 0.18s ease;
    }
    .sidebar.rail { width: 260px; } /* rail concept doesn't apply on mobile — always full drawer */
    .sidebar.rail .nav-list { display: flex; } /* force the nav list visible in the mobile drawer regardless of desktop rail state */
    /* M103 — the desktop rail mode's icon-only hides (labels, gutter placeholder) shouldn't carry
       into the mobile drawer either: a mobile user who collapsed the sidebar on desktop still gets
       the full drawer, not an icon-only one, when they open it here. */
    .sidebar.rail .nav-label { display: inline; }
    .sidebar.rail .side-row-gutter { display: inline-block; }
    .sidebar.rail .nav-item { justify-content: flex-start; gap: 0.6rem; padding: 0.6rem 0.75rem; }
    .sidebar.rail .side-divider { display: block; }
    .sidebar.rail .side-row-action { display: inline-flex; }
    .sidebar.open { transform: translateX(0); box-shadow: 0 8px 30px rgba(0,0,0,0.18); }
    .sidebar-scrim {
      display: block; position: fixed; z-index: 25;
      top: var(--shell-top); left: 0; right: 0; bottom: 0;
      border: none; background: rgba(0,0,0,0.25);
    }
  }

  @media print {
    .sidebar, .sidebar-scrim { display: none !important; }
  }
</style>

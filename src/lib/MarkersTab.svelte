<script lang="ts">
  import type { Vault, Client, MarkerResult, NoteAttachment } from "./types";
  import Button from "@tinytars/frame/Button.svelte";
  import { ALL_GROUP_KEY } from "./sidebar-labels";
  import { currentZoneStatus, resolveRange } from "@pablotech/akesi-pil/ranges";
  import type { UnitSystem } from "./units";
  import MarkerChart from "./MarkerChart.svelte";
  import { markerAnchor, ratioAnchor, findByAnchor } from "./anchor";
  import { deltaForSeries } from "@pablotech/akesi-pil/marker-deltas";
  import { buildMarkerRatios } from "./marker-ratios";
  import { groupsOnly, byPinnedThenConcern, concernThenName, countGroups, flatMarkers, markerSystemIndex, type GroupSection } from "./marker-grid";
  import { sortPinnedFirst } from "./pin-sort";
  import { resolveGroup } from "@tinytars/frame/group-filter";
  import { groupBySystem, systemAnalysisEstablished, systemOrder, UNCATEGORIZED } from "@pablotech/akesi-pil/system-groups";
  import PendingGrouping from "./PendingGrouping.svelte";
  import type { Permalink } from "./permalink";

  // The Markers experience: the interactive marker wall with its own filters
  // (view mode / source / window / text search) and the multi-client Family view.
  // windowYears is owned by the shell (the print document needs it too) and bound
  // back here so the control lives with the markers. Relocation of App.svelte's
  // marker grid — the derivation logic is unchanged.
  interface Props {
    vault: Vault;
    client: Client | null; // null → Family view
    clientId?: string | null;
    unitSystem: UnitSystem;
    windowYears: number;
    onToggleWatchlist?: (name: string) => void;
    onTogglePinnedRatio?: (name: string) => void;
    canTranslate?: boolean;
    onTranslate?: (client: Client, marker: string) => Promise<void>;
    // M95 — triggers web-side marker->body-system classification for the "Not yet categorized"
    // group (self-service accounts can't reach the CLI's --refresh-marker-groups). No canX gate
    // like canTranslate — visible to the account owner and any granted provider alike.
    onCategorizeMarkers?: (client: Client) => Promise<void>;
    // M70/Phase 0 — plumbing only; forwarded to MarkerChart, wired to a "Chat" button in a later phase.
    onStartChat?: (pl: Permalink) => void;
    // M-annotate — forwarded to MarkerChart's "Annotate" menu item.
    onCreateNote?: (attachment: NoteAttachment) => void;
    // M76/Phase 2 — which sidebar group ("ratios" or "level:<system>") is selected; the page renders
    // exactly that one block instead of every group stacked. Bindable so the pendingAnchor
    // reverse-match effect below can switch it.
    activeGroup?: string | null;
    // A deep-linked anchor whose owning group may not be the currently active one; reverse-matched
    // against the full unfiltered marker/ratio set below, then cleared via onConsumeAnchor.
    pendingAnchor?: string | null;
    onConsumeAnchor?: () => void;
  }
  let {
    vault, client, clientId = null, unitSystem, windowYears = $bindable(), onToggleWatchlist, onTogglePinnedRatio,
    canTranslate = false, onTranslate, onStartChat, onCreateNote, onCategorizeMarkers,
    activeGroup = $bindable(null), pendingAnchor = null, onConsumeAnchor,
  }: Props = $props();

  // M95 — local pending/error state for the "Categorize by body system" trigger, mirroring
  // MarkerChart's translating/onTranslate pattern.
  let categorizing = $state(false);
  let categorizeError = $state<string | null>(null);

  async function doCategorize() {
    if (!onCategorizeMarkers || !client) return;
    categorizing = true;
    categorizeError = null;
    try {
      await onCategorizeMarkers(client);
    } catch (e) {
      categorizeError = (e as Error).message ?? "categorization failed";
    } finally {
      categorizing = false;
    }
  }

  // Family (cross-client) view keeps its own per-card inline expand — untouched, out of scope
  // for M85 Phase 9's redesign.
  let expandedExplanations = $state(new Set<string>());

  function toggleExplanation(name: string) {
    const next = new Set(expandedExplanations);
    if (next.has(name)) next.delete(name); else next.add(name);
    expandedExplanations = next;
  }

  // M88 — replaces the shared right-hand Details panel with per-row inline expand (each
  // MarkerChart large-size row shows its own MarkerDetails when expanded), mirroring the Family
  // view's expandedExplanations/toggleExplanation pattern above.
  let expandedMarkers = $state(new Set<string>());
  function toggleExpanded(name: string) {
    const next = new Set(expandedMarkers);
    if (next.has(name)) next.delete(name); else next.add(name);
    expandedMarkers = next;
  }

  let flat = $derived(client ? flatMarkers(client) : []);
  let index = $derived(client ? markerSystemIndex(client) : new Map<string, string>());
  // M74 — starred ratios (see types.ts Client.pinnedRatios note: kept separate from watchlist).
  let pinnedRatioNames = $derived(new Set(client?.pinnedRatios ?? []));
  // Finding-personalized ratios, sorted Starred → Red → Orange → Green → Other (M74 — replaces
  // the old Watchlist-block promotion; starring now bubbles within this list instead).
  let ratios = $derived(
    client
      ? sortPinnedFirst(
          buildMarkerRatios(client).sort(
            concernThenName(
              (rv) => currentZoneStatus(rv.rows[rv.rows.length - 1]?.value ?? null, rv.range),
              (rv) => rv.ratio.name,
            ),
          ),
          (rv) => pinnedRatioNames.has(rv.ratio.name),
        )
      : [],
  );
  // Primary: group by body system. Null when the Finding hasn't established systems.
  let systemGroups = $derived.by(() => (client ? groupBySystem(client, flat, (m) => index.get(m.name)) : null));
  // M76/Phase 2 — which single group renders. Trusts activeGroup when it's a valid key for the
  // current client; otherwise picks a sensible default (Ungrouped if it has content, else Ratios,
  // else the first system) — defensive only, since the real default-setting responsibility lives in
  // App.svelte's default-group effect. Guards against a stale "level:<system>" (or "ratios" with
  // nothing to show) surviving a client switch or Finding regen that shrank a group to empty.
  // The rows markerSidebarGroups actually emits, derived from the same inputs it uses: All and
  // Ratios always, plus one per system that has markers (it skips empty systems).
  let groupKeys = $derived(
    new Set([ALL_GROUP_KEY, "ratios", ...(systemGroups ?? []).map((g) => "level:" + g.system)]),
  );
  // W62 P8 — a selected row is honoured even when it is EMPTY, per the shared rule in
  // group-filter.ts: showing another group's content is never the answer. The old ladder fell
  // through to the whole marker wall whenever Ratios was picked with no ratios on file — the Ratios
  // row is emitted at count 0 — so the click looked ignored and the wall looked like it was "the
  // ratios". The fallbacks below now fire only when activeGroup names NO row at all: nothing
  // selected yet, or a stale key surviving a client switch or a regen that dropped a system.
  let resolvedGroup = $derived(
    resolveGroup(activeGroup, groupKeys, () => {
      if (flat.length > 0) return ALL_GROUP_KEY;
      if (ratios.length > 0) return "ratios";
      if (systemGroups && systemGroups.length > 0) return "level:" + systemGroups[0].system;
      return activeGroup;
    }),
  );
  // Keep the bound activeGroup in sync with the resolved value — Sidebar highlights activeGroup
  // directly (not resolvedGroup), so without this it could stay stuck showing "Ratios" selected
  // while the body actually renders a fallback system group.
  $effect(() => {
    if (resolvedGroup !== activeGroup) activeGroup = resolvedGroup;
  });
  let activeSystemGroup = $derived(systemGroups?.find((g) => "level:" + g.system === resolvedGroup) ?? null);
  // M76/Phase 2 — a deep-linked marker/ratio anchor whose owning group isn't the currently active
  // one would otherwise never mount under single-group rendering. Reverse-match it against the
  // full unfiltered ratio/marker set (not the text-filtered/active-group-narrowed ones above),
  // switch to its owning group, then let the caller clear pendingAnchor.
  $effect(() => {
    if (!pendingAnchor) return;
    // W64 — findByAnchor, not `===`: a marker/ratio deep link is often an item-level anchor whose
    // id is this one plus a suffix, and strict equality never matched it here.
    const ratioHit = findByAnchor(ratios, pendingAnchor, (rv) => ratioAnchor(rv.ratio.name));
    if (ratioHit) {
      activeGroup = "ratios";
      expandedMarkers = new Set([...expandedMarkers, ratioHit.ratio.name]);
      onConsumeAnchor?.();
      return;
    }
    const marker = findByAnchor(flat, pendingAnchor, (m) => markerAnchor(m.name));
    if (marker) {
      const system = index.get(marker.name);
      if (system) activeGroup = "level:" + system;
      expandedMarkers = new Set([...expandedMarkers, marker.name]);
      onConsumeAnchor?.();
    }
  });
  // Fallback (no System Analysis yet): the panel wall (M102 — no source split).
  let fallbackGroups = $derived.by((): GroupSection[] => {
    if (!client || systemGroups) return [];
    return groupsOnly(client);
  });
  let visibleCount = $derived(systemGroups ? flat.length : countGroups(fallbackGroups));
  // W65 — the two "no markers match the current window/filters" empty states are gone with the
  // window-as-filter reading. Neither could ever render: both counts are flatMarkers' whole set, so
  // `visibleCount === 0` implied `client.results.length === 0`, which the branch above already
  // handles with its own message. They were the only UI claiming the window narrowed this list, and
  // one of them printed "0 markers on file — widen the window to see them".

  type MarkerSection = { name: string; perClient: { client: Client; rows: MarkerResult[] }[] };
  // Named apart from marker-grid's GroupSection: the Family view groups one marker across several
  // clients, the single-client wall groups rows of one client. Sharing the name meant the local
  // declaration silently won over the import, and every `fallbackGroups` read was type-checked
  // against the wrong shape.
  type FamilyGroupSection = { group: string; markers: MarkerSection[] };
  // W26 — group the family watchlist by body system (each client's own markerSystemIndex),
  // cross-source. System order = union of every client's systemOrder (display-name order,
  // first-seen), "Not yet categorized" last. Falls back to lab-panel grouping only when no
  // client has a Finding yet.
  function familyGroups(v: Vault): FamilyGroupSection[] {
    const clients = Object.values(v.clients).sort((a, b) => a.displayName.localeCompare(b.displayName));
    const byMarker = new Map<string, { system?: string; panel: string; perClient: { client: Client; rows: MarkerResult[] }[] }>();
    const order: string[] = [];
    const seen = new Set<string>();
    let anyFinding = false;
    for (const c of clients) {
      if (systemAnalysisEstablished(c)) {
        anyFinding = true;
        for (const s of systemOrder(c)) if (!seen.has(s)) { seen.add(s); order.push(s); }
      }
      const idx = markerSystemIndex(c);
      const results = new Map<string, MarkerResult[]>();
      for (const r of c.results) {
        if (!results.has(r.marker)) results.set(r.marker, []);
        results.get(r.marker)!.push(r);
      }
      for (const name of c.watchlist) {
        const rows = results.get(name);
        if (!rows || rows.length === 0) continue;
        rows.sort((a, b) => a.date.localeCompare(b.date));
        if (!byMarker.has(name)) byMarker.set(name, { panel: rows[0].group || "Other", perClient: [] });
        const entry = byMarker.get(name)!;
        entry.perClient.push({ client: c, rows });
        if (entry.system === undefined && idx.has(name)) entry.system = idx.get(name);
      }
    }
    const byGroup = new Map<string, MarkerSection[]>();
    const panelOrder: string[] = [];
    for (const [name, { system, panel, perClient }] of byMarker) {
      const key = anyFinding
        ? system && order.includes(system) ? system : UNCATEGORIZED
        : panel;
      if (!byGroup.has(key)) { byGroup.set(key, []); if (!anyFinding) panelOrder.push(key); }
      byGroup.get(key)!.push({
        name,
        perClient: perClient.sort((a, b) => a.client.displayName.localeCompare(b.client.displayName)),
      });
    }
    const keys = anyFinding
      ? [...order, UNCATEGORIZED].filter((g) => byGroup.has(g))
      : panelOrder.sort((a, b) => a.localeCompare(b));
    return keys.map((group) => ({ group, markers: byGroup.get(group)!.sort((a, b) => a.name.localeCompare(b.name)) }));
  }
  let family = $derived(!client ? familyGroups(vault) : []);
</script>

<div class="markers-tab leaf-section">
  {#if !client}
    <h2 class="family-title">Family</h2>
    {#if family.length === 0}
      <p class="leaf-empty">No watchlisted markers across the vault yet.</p>
    {:else}
      {#each family as g (g.group)}
        <section class="family-group">
          <h3>{g.group}</h3>
          {#each g.markers as m (m.name)}
            <div class="family-marker">
              <h4>{m.name}</h4>
              <div class="grid">
                {#each m.perClient as pc (pc.client.displayName)}
                  <MarkerChart
                    name={m.name}
                    caption={pc.client.displayName}
                    rows={pc.rows}
                    client={pc.client}
                    highlighted
                    status={currentZoneStatus(pc.rows[pc.rows.length - 1]?.value ?? null, resolveRange(m.name, pc.client))}
                    delta={deltaForSeries(pc.rows)}
                    {windowYears}
                    {unitSystem}
                    chartId={markerAnchor(m.name) + "-" + pc.client.displayName.toLowerCase()}
                    expanded={expandedExplanations.has(m.name + "|" + pc.client.displayName)}
                    onToggle={() => toggleExplanation(m.name + "|" + pc.client.displayName)}
                    {onStartChat}
                    {onCreateNote}
                  />
                {/each}
              </div>
            </div>
          {/each}
        </section>
      {/each}
    {/if}
  {:else}
    {#if client.results.length === 0}
      <p class="leaf-empty">No data yet — use <strong>Import</strong> in the sidebar to add a lab spreadsheet, report, or device export and get started.</p>
    {:else if resolvedGroup === "ratios" && ratios.length === 0}
      <p class="leaf-empty">No marker ratios on file for {client.displayName}.</p>
    {:else}
      <section class="client-section">
        <div class="markers-list">
            {#if ratios.length > 0 && resolvedGroup === "ratios"}
              {@const ratioClient = { ...client, personalizedRanges: { ...client.personalizedRanges, ...Object.fromEntries(ratios.flatMap((rv) => (rv.range ? [[rv.ratio.name, rv.range] as const] : []))) } }}
              <div class="marker-ratios-screen">
                <div class="stack">
                  {#each ratios as rv (rv.ratio.name)}
                    <MarkerChart
                      name={rv.ratio.name}
                      rows={rv.rows}
                      client={ratioClient}
                      {clientId}
                      size="large"
                      highlighted={pinnedRatioNames.has(rv.ratio.name)}
                      status={currentZoneStatus(rv.rows[rv.rows.length - 1]?.value ?? null, rv.range)}
                      delta={deltaForSeries(rv.rows)}
                      {windowYears}
                      {unitSystem}
                      chartId={ratioAnchor(rv.ratio.name)}
                      expanded={expandedMarkers.has(rv.ratio.name)}
                      onToggle={() => toggleExpanded(rv.ratio.name)}
                      onToggleWatchlist={onTogglePinnedRatio}
                      {canTranslate}
                      onTranslate={async () => { await onTranslate?.(client, rv.ratio.name); }}
                      {onStartChat}
                    {onCreateNote}
                    />
                  {/each}
                </div>
              </div>
            {/if}
            {#if visibleCount > 0 && resolvedGroup !== "ratios"}
            {#if resolvedGroup === ALL_GROUP_KEY}
              <div class="other-source">
                <div class="stack">
                  {#each byPinnedThenConcern(flat) as m (m.name)}
                    <MarkerChart
                      name={m.name}
                      rows={m.rows}
                      client={client}
                      {clientId}
                      size="large"
                      highlighted={m.highlighted}
                      status={m.status}
                      delta={deltaForSeries(m.rows)}
                      {windowYears}
                      {unitSystem}
                      chartId={markerAnchor(m.name)}
                      expanded={expandedMarkers.has(m.name)}
                      onToggle={() => toggleExpanded(m.name)}
                      {onToggleWatchlist}
                      {canTranslate}
                      onTranslate={async () => { await onTranslate?.(client, m.name); }}
                      {onStartChat}
                    {onCreateNote}
                    />
                  {/each}
                </div>
              </div>
            {:else if systemGroups}
              {#if activeSystemGroup}
                {@const grp = activeSystemGroup}
                {#if grp.system === UNCATEGORIZED && onCategorizeMarkers}
                  <div class="uncategorized-note">
                    <p class="pending-grouping">
                      ⓘ These markers haven't been sorted into body systems yet.
                    </p>
                    <Button primary disabled={categorizing} onclick={doCategorize}>
                      {categorizing ? "Categorizing…" : "Categorize by body system"}
                    </Button>
                    {#if categorizeError}<p class="categorize-error">{categorizeError}</p>{/if}
                  </div>
                {/if}
                <div class="other-source">
                  <div class="stack">
                    {#each byPinnedThenConcern(grp.rows) as m (m.name)}
                      <MarkerChart
                        name={m.name}
                        rows={m.rows}
                        client={client}
                        {clientId}
                        size="large"
                        highlighted={m.highlighted}
                        status={m.status}
                        delta={deltaForSeries(m.rows)}
                        {windowYears}
                        {unitSystem}
                        chartId={markerAnchor(m.name)}
                        expanded={expandedMarkers.has(m.name)}
                        onToggle={() => toggleExpanded(m.name)}
                        {onToggleWatchlist}
                        {canTranslate}
                        onTranslate={async () => { await onTranslate?.(client, m.name); }}
                        {onStartChat}
                    {onCreateNote}
                      />
                    {/each}
                  </div>
                </div>
              {/if}
            {:else}
              <PendingGrouping />
              {#each fallbackGroups as g (g.group)}
                <div class="other-group">
                  <h5>{g.group}</h5>
                  <div class="stack">
                    {#each g.markers as m (m.name)}
                      <MarkerChart
                        name={m.name}
                        rows={m.rows}
                        client={client}
                        {clientId}
                        size="large"
                        highlighted={m.highlighted}
                        status={m.status}
                        delta={deltaForSeries(m.rows)}
                        {windowYears}
                        {unitSystem}
                        chartId={markerAnchor(m.name)}
                        expanded={expandedMarkers.has(m.name)}
                        onToggle={() => toggleExpanded(m.name)}
                        {onToggleWatchlist}
                        {canTranslate}
                        onTranslate={async () => { await onTranslate?.(client, m.name); }}
                        {onStartChat}
                    {onCreateNote}
                      />
                    {/each}
                  </div>
                </div>
              {/each}
            {/if}
            {/if}
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .family-title { margin: 0 0 1rem; font-size: 1.25rem; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    align-items: start;
    gap: 1rem;
  }
  /* M85 Phase 9 — the single-client tall list (ratios/system-group/fallback blocks) replaces the
     3-wide .grid with a single column of larger plots; Family's cross-client .grid above is
     untouched (out of scope — different layout need). */
  .stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .markers-list { min-width: 0; }
  .family-group, .client-section { margin-bottom: 2rem; }
  .marker-ratios-screen { margin-bottom: 1.75rem; }
  /* M101 — converged onto the "system" heading family Study.svelte's .sr-system and
     UnifiedTreatment.svelte's .ct-system already use: these headings (family-group h3 and
     other-group h5) both label a body-system group, just via two parallel grouping paths
     (vault-wide family view vs a single client's fallback ungrouped view). */
  .family-group h3, .other-group h5 {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--accent);
  }
  .family-group h3 { margin-bottom: 0.75rem; }
  .family-marker { margin-bottom: 1rem; }
  .family-marker h4 { margin: 0 0 0.4rem; font-size: 0.9rem; color: var(--muted); font-weight: 500; }
  .other-group { margin-bottom: 1.5rem; }
  .other-source { margin-bottom: 1.5rem; }
  .uncategorized-note { margin-bottom: 1.5rem; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .pending-grouping { margin: 0; font-size: 0.8rem; font-style: italic; color: var(--muted); }
  .categorize-error { margin: 0; font-size: 0.8rem; color: var(--alert); }
</style>

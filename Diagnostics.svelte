<script module lang="ts">
  // Domain-neutral shape for one operational-audit row (mirrors refresh-client.ts's RefreshLogEntry
  // in health-dash-web, kept structurally compatible so App.svelte can pass fetchRefreshLog straight
  // through as fetchLog without either side importing the other's type).
  export interface DiagnosticsLogEntry {
    at: string;
    event: string;
    status: number;
    attempt?: number;
    chars?: number;
    usage?: { input: number; output: number };
    errorCode?: string;
    reasonCategory?: string;
    latencyMs?: number;
    requestId?: string;
  }
</script>

<script lang="ts">
  // W39/Phase 4 — provider-only refresh diagnostics. Reads the PHI-free R2 audit trail via GET
  // /api/logs and renders it as a table: outcome, attempt, token cost, latency — newest first. This is
  // where a provider confirms "it tried 3 times, hit a truncation, and stopped" instead of guessing
  // from a vanishing counter (the exact fear W39 answers).
  import { onMount } from "svelte";

  interface Props {
    token: string;
    fetchLog: (token: string) => Promise<DiagnosticsLogEntry[]>;
    noteText?: string;
    emptyText?: string;
  }
  let {
    token,
    fetchLog,
    noteText = "Operational trail of recent runs — outcome, attempts, and cost. Newest first (times UTC).",
    emptyText = "No events recorded yet.",
  }: Props = $props();

  let entries = $state<DiagnosticsLogEntry[] | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  async function load() {
    loading = true;
    error = null;
    try {
      entries = await fetchLog(token);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  const time = (iso: string) => (iso.length >= 19 ? iso.slice(11, 19) : iso); // HH:MM:SS (UTC)
  const day = (iso: string) => (iso.length >= 10 ? iso.slice(0, 10) : "");
  const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
</script>

<div class="diag">
  <div class="diag-head">
    <p class="diag-note">{noteText}</p>
    <button class="diag-reload" onclick={load} disabled={loading}>{loading ? "Loading…" : "↻ Reload"}</button>
  </div>

  {#if error}
    <p class="diag-msg diag-error">Couldn’t load the log: {error}</p>
  {:else if loading && !entries}
    <p class="diag-msg">Loading…</p>
  {:else if entries && entries.length === 0}
    <p class="diag-msg">{emptyText}</p>
  {:else if entries}
    <table class="diag-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Event</th>
          <th>Try</th>
          <th>Tokens in/out</th>
          <th>Chars</th>
          <th>Reason / code</th>
          <th>Latency</th>
        </tr>
      </thead>
      <tbody>
        {#each entries as e, i (e.at + e.event + (e.attempt ?? "") + (e.requestId ?? "") + i)}
          <tr>
            <td title={day(e.at)}>{time(e.at)}</td>
            <td><span class="ev ev-{e.event}">{e.event}</span></td>
            <td>{e.attempt ?? "—"}</td>
            <td>{e.usage ? `${tok(e.usage.input)} / ${tok(e.usage.output)}` : "—"}</td>
            <td>{e.chars ?? "—"}</td>
            <td>{e.reasonCategory ?? e.errorCode ?? "—"}</td>
            <td>{typeof e.latencyMs === "number" ? secs(e.latencyMs) : "—"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="diag-scroll-hint">Scroll sideways for more columns →</p>
  {/if}
</div>

<style>
  .diag {
    min-width: min(46rem, 80vw);
    overflow-x: auto;
  }
  .diag-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.75rem;
  }
  .diag-note {
    margin: 0;
    font-size: 0.85rem;
    color: var(--muted, #667);
    max-width: 40rem;
  }
  .diag-reload {
    flex: none;
    font-size: 0.8rem;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .diag-msg {
    font-size: 0.9rem;
    color: var(--muted, #667);
  }
  .diag-error {
    color: var(--alert);
  }
  .diag-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }
  .diag-table th,
  .diag-table td {
    text-align: left;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border, #e3e3ea);
    white-space: nowrap;
  }
  .diag-table th {
    font-weight: 600;
    color: var(--muted, #667);
  }
  /* M100 — the table is horizontal-scroll-only (no visible scrollbar affordance on touch
     browsers); a text hint makes that discoverable on phone widths. */
  .diag-scroll-hint {
    display: none;
    margin: 0.4rem 0 0;
    font-size: 0.78rem;
    color: var(--muted, #667);
  }
  @media (max-width: 640px) {
    .diag-scroll-hint { display: block; }
  }
  .ev {
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    padding: 0.05rem 0.35rem;
    border-radius: 0.25rem;
    background: #eef;
    color: #335;
  }
  .ev-success {
    background: var(--safe-band);
    color: var(--safe);
  }
  .ev-error,
  .ev-gave-up,
  .ev-truncated {
    background: var(--alert-band);
    color: var(--alert);
  }
  .ev-validation-fail,
  .ev-aborted,
  .ev-cancelled {
    background: var(--warn-band);
    color: var(--warn);
  }
</style>

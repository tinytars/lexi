// W72 — the Account panel's disclosure log, turned back into a disclosure log.
//
// `phi_access_events` records one row per PHI object touched, and the panel rendered one line per
// row in the frozen internal vocabulary (`raw_namespace_listed · 3/4/2026, 11:02:00 AM`), with no
// actor and under a heading that belonged to a different control. That is the very outcome
// functions/_lib/phi-audit.ts:10-13 set out to avoid when it excluded the subject's own reads —
// "turn a disclosure log into a traffic log" — reintroduced at the rendering end.
//
// Two transformations fix it, and both are here rather than in markup so they can be tested without
// mounting anything:
//
//   partitionAccessEvents  splits LexiTar's own recovery-key uses from third-party reads, because
//                          the recovery-key paragraph promises "every use of it is listed below"
//                          and only those rows answer it.
//   groupIntoEpisodes      collapses a burst of per-object rows by one actor into one line. A
//                          provider opening a record emits a listing, several blob reads and a
//                          roster view within seconds; those are one visit, not nine events.
//
// Nothing is filtered away. Every raw row survives inside its episode's `events`, which is what the
// component puts behind an expander — an audit log that hides a row is not one.
import type { AccessEventRow } from "@tinytars/vault/auth-recovery";

/**
 * How long a quiet gap has to be before the same actor's next read is a separate visit.
 *
 * Thirty minutes, and the range it sits in the middle of is what chose it. A provider opening one
 * record emits its listing, its blob reads and a roster view inside a minute or two, so a burst is
 * a couple of minutes wide; a second sitting is separated by tens of minutes or more. Any threshold
 * between four minutes and an hour therefore reports two such sittings as two visits, and the
 * middle of that range is the least sensitive place to stand: far enough above the burst width that
 * a slow page load cannot split one visit in half, far enough below an hour that two real visits do
 * not merge into one line.
 */
export const EPISODE_GAP_MS = 30 * 60_000;

export interface AccessEpisode {
  /** The newest row's id — stable across refreshes, so it keys a Svelte `{#each}` honestly. */
  id: string;
  actorAccountId: string;
  /** ISO timestamp of the EARLIEST row in the episode. */
  from: string;
  /** ISO timestamp of the LATEST row. Equal to `from` for a single-row episode. */
  to: string;
  count: number;
  /** Distinct actions, newest-first order of first appearance. */
  actions: string[];
  /** Every raw row, newest first. Nothing is dropped. */
  events: AccessEventRow[];
}

/**
 * Plain-language phrases for the frozen `PHI_ACCESS_ACTIONS` vocabulary, plus `org_key_decrypt`,
 * which operator scripts write and which is deliberately NOT a member of that list
 * (apps/lexitar/scripts/access-log.ts:134, scripts/recovery-approve.ts:165).
 *
 * Each phrase completes the sentence "<someone> …", so the component never has to inflect one.
 */
export const ACTION_PHRASES: Record<string, string> = {
  vault_blob_read: "read your record",
  vault_blob_read_ops: "read your record from an operator tool",
  vault_blob_written: "saved a change to your record",
  raw_object_read: "opened a file in your record",
  raw_namespace_listed: "listed what your record contains",
  document_text_read: "read a document in your record",
  provider_roster_viewed: "looked at who has access",
  provider_access_revoked: "removed someone's access",
  org_key_decrypt: "used LexiTar's recovery key on your record",
};

/**
 * The phrase for an action, or the raw action name when there is none.
 *
 * The fallback is the point: a row whose action nobody has written a phrase for is still shown, in
 * the only words available. access-episodes.test.ts asserts from the other side — it imports
 * `PHI_ACCESS_ACTIONS` and fails if a member of that frozen list reaches this fallback — so adding
 * an action to the vocabulary without a phrase breaks a test instead of quietly shipping jargon.
 */
export function actionPhrase(action: string): string {
  return ACTION_PHRASES[action] ?? action;
}

/**
 * Is this row LexiTar's own recovery key being used, rather than a third party reading the record?
 *
 * Keyed on the ACTOR, not the action: `org_key_decrypt` is not in the frozen action vocabulary at
 * all, so an operator path that logged a different action under the org principal would still
 * belong in the recovery-key section. The action check is the fallback for the case where the
 * client has no `orgAccountId` yet (an empty string, before principals load).
 */
export function isOrgKeyUse(ev: AccessEventRow, orgAccountId: string): boolean {
  if (orgAccountId !== "" && ev.actorAccountId === orgAccountId) return true;
  return ev.action === "org_key_decrypt";
}

/** Split the log into LexiTar's own recovery-key uses and everyone else's reads, order preserved. */
export function partitionAccessEvents(
  events: readonly AccessEventRow[],
  orgAccountId: string
): { orgUses: AccessEventRow[]; others: AccessEventRow[] } {
  const orgUses: AccessEventRow[] = [];
  const others: AccessEventRow[] = [];
  for (const ev of events) (isOrgKeyUse(ev, orgAccountId) ? orgUses : others).push(ev);
  return { orgUses, others };
}

/**
 * Collapse consecutive rows by the same actor into one episode per visit.
 *
 * The input is sorted here rather than trusted: the route returns newest-first today
 * (functions/_lib/identity-audit.ts:45) and this must not silently mis-group if that ever changes.
 */
export function groupIntoEpisodes(
  events: readonly AccessEventRow[],
  gapMs: number = EPISODE_GAP_MS
): AccessEpisode[] {
  const sorted = [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const out: AccessEpisode[] = [];
  for (const ev of sorted) {
    const open = out[out.length - 1];
    const withinGap = open ? Date.parse(open.from) - Date.parse(ev.createdAt) <= gapMs : false;
    if (open && open.actorAccountId === ev.actorAccountId && withinGap) {
      open.events.push(ev);
      open.from = ev.createdAt;
      open.count += 1;
      if (!open.actions.includes(ev.action)) open.actions.push(ev.action);
      continue;
    }
    out.push({
      id: ev.id,
      actorAccountId: ev.actorAccountId,
      from: ev.createdAt,
      to: ev.createdAt,
      count: 1,
      actions: [ev.action],
      events: [ev],
    });
  }
  return out;
}

/**
 * What the episode did, in words: one phrase, or the first phrase plus a count of the rest.
 *
 * Listing nine phrases is the traffic log again in longer form, so the summary names the first
 * action and says how many other kinds there were; the expander has every row.
 */
export function episodeActions(ep: AccessEpisode): string {
  const first = actionPhrase(ep.actions[0]);
  if (ep.actions.length === 1) return first;
  const rest = ep.actions.length - 1;
  return `${first}, and ${rest} other ${rest === 1 ? "kind" : "kinds"} of access`;
}

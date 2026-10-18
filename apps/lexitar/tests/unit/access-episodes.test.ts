import { describe, it, expect } from "vitest";
import {
  ACTION_PHRASES,
  EPISODE_GAP_MS,
  actionPhrase,
  episodeActions,
  groupIntoEpisodes,
  isOrgKeyUse,
  partitionAccessEvents,
} from "../../src/lib/access-episodes";
import { PHI_ACCESS_ACTIONS } from "../../functions/_lib/phi-audit";
import type { AccessEventRow } from "@tinytars/vault/auth-recovery";

// W72 — the Account panel's disclosure log. These are pure-function tests over the grouper, plus one
// assertion DERIVED from the frozen action vocabulary itself, in the shape a11y-static.test.ts's
// header asks for: a NEW action added to PHI_ACCESS_ACTIONS without a phrase fails here without
// anyone remembering to update this file.

const t = (iso: string) => `2026-03-04T${iso}Z`;
let seq = 0;
function row(actor: string, action: string, createdAt: string): AccessEventRow {
  return { id: `ev${++seq}`, action, actorAccountId: actor, vaultId: null, consentRef: null, meta: {}, createdAt };
}

describe("every action the log can hold has words a patient can read", () => {
  // The panel rendered the frozen internal names verbatim — `raw_namespace_listed · 3/4/2026,
  // 11:02:00 AM`. The fallback in actionPhrase() means a missing phrase is still SHOWN rather than
  // hidden, which is right for an audit log and is also why nothing but this test would notice.
  it("covers the whole frozen PHI_ACCESS_ACTIONS vocabulary", () => {
    expect(PHI_ACCESS_ACTIONS.length).toBeGreaterThan(4);
    const unphrased = PHI_ACCESS_ACTIONS.filter((a) => actionPhrase(a) === a);
    expect(unphrased, "actions that would render as internal jargon").toEqual([]);
  });

  it("covers org_key_decrypt, which that vocabulary deliberately does not contain", () => {
    // Written by operator scripts (scripts/access-log.ts, scripts/recovery-approve.ts), so it is
    // absent from the route's own list and would be missed by the assertion above.
    expect(PHI_ACCESS_ACTIONS).not.toContain("org_key_decrypt" as never);
    expect(ACTION_PHRASES.org_key_decrypt).toBeTruthy();
  });

  it("falls back to the raw action rather than dropping it", () => {
    expect(actionPhrase("something_new_nobody_phrased")).toBe("something_new_nobody_phrased");
  });
});

describe("LexiTar's own recovery-key uses are told apart from a third party's reads", () => {
  const org = "00000000-org";
  const provider = "5eedc000";

  it("partitions on the ACTOR, not the action", () => {
    // Keyed on the actor because the action vocabulary does not contain org_key_decrypt at all, so
    // an operator path logging a different action under the org principal still belongs up top.
    const events = [
      row(org, "vault_blob_read", t("06:25:01")),
      row(provider, "raw_namespace_listed", t("04:46:00")),
    ];
    const { orgUses, others } = partitionAccessEvents(events, org);
    expect(orgUses.map((e) => e.actorAccountId)).toEqual([org]);
    expect(others.map((e) => e.actorAccountId)).toEqual([provider]);
  });

  it("still finds an org-key use before the principals have loaded", () => {
    // orgAccountId is "" until getVaultPrincipals() resolves; the action is the fallback so the
    // first paint does not file a recovery-key use under "who has opened your record".
    const ev = row("whoever", "org_key_decrypt", t("06:25:01"));
    expect(isOrgKeyUse(ev, "")).toBe(true);
    const { orgUses } = partitionAccessEvents([ev], "");
    expect(orgUses).toHaveLength(1);
  });

  it("does not claim a third party's read is the recovery key", () => {
    expect(isOrgKeyUse(row(provider, "vault_blob_read", t("04:46:00")), org)).toBe(false);
  });
});

describe("a burst of per-object rows is one visit", () => {
  const provider = "5eedc000";

  it("collapses a two-sitting burst pattern into two episodes, losing no row", () => {
    // One actor, two sittings: three reads inside a minute, and two more about an hour before.
    const events = [
      row(provider, "raw_namespace_listed", t("04:46:00")),
      row(provider, "vault_blob_read", t("04:45:30")),
      row(provider, "raw_object_read", t("04:45:02")),
      row(provider, "provider_roster_viewed", t("03:43:10")),
      row(provider, "vault_blob_read", t("03:40:00")),
    ];
    const episodes = groupIntoEpisodes(events);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].count).toBe(3);
    expect(episodes[1].count).toBe(2);
    expect(episodes.flatMap((e) => e.events)).toHaveLength(events.length);
  });

  it("carries the span and the distinct actions, newest first", () => {
    const events = [
      row(provider, "raw_namespace_listed", t("04:46:00")),
      row(provider, "vault_blob_read", t("04:45:30")),
      row(provider, "vault_blob_read", t("04:45:02")),
    ];
    const [ep] = groupIntoEpisodes(events);
    expect(ep.to).toBe(t("04:46:00"));
    expect(ep.from).toBe(t("04:45:02"));
    expect(ep.actions).toEqual(["raw_namespace_listed", "vault_blob_read"]);
    expect(ep.id).toBe(events[0].id); // the newest row keys the episode
  });

  it("never merges two different actors, however close in time", () => {
    const events = [row("aaa", "vault_blob_read", t("04:46:00")), row("bbb", "vault_blob_read", t("04:46:01"))];
    expect(groupIntoEpisodes(events)).toHaveLength(2);
  });

  it("splits on the gap threshold from both sides of it", () => {
    const base = Date.parse(t("04:00:00"));
    const at = (ms: number) => new Date(base - ms).toISOString();
    expect(groupIntoEpisodes([row("a", "vault_blob_read", at(0)), row("a", "vault_blob_read", at(EPISODE_GAP_MS - 1000))])).toHaveLength(1);
    expect(groupIntoEpisodes([row("a", "vault_blob_read", at(0)), row("a", "vault_blob_read", at(EPISODE_GAP_MS + 1000))])).toHaveLength(2);
  });

  it("sorts rather than trusting the route's ordering", () => {
    // identity-audit.ts returns newest-first today. If that ever changes, the grouper must not
    // silently report one visit per row.
    const events = [
      row("a", "vault_blob_read", t("04:45:02")),
      row("a", "vault_blob_read", t("04:46:00")),
      row("a", "vault_blob_read", t("04:45:30")),
    ];
    const [ep] = groupIntoEpisodes(events);
    expect(ep.count).toBe(3);
    expect(ep.to).toBe(t("04:46:00"));
  });

  it("is empty for an empty log", () => {
    expect(groupIntoEpisodes([])).toEqual([]);
  });
});

describe("the summary line says what happened without listing nine phrases", () => {
  it("names the one action when there is one", () => {
    const [ep] = groupIntoEpisodes([row("a", "vault_blob_read", t("04:46:00"))]);
    expect(episodeActions(ep)).toBe(ACTION_PHRASES.vault_blob_read);
  });

  it("names the first and counts the other kinds, singular and plural", () => {
    const two = groupIntoEpisodes([
      row("a", "raw_namespace_listed", t("04:46:00")),
      row("a", "vault_blob_read", t("04:45:00")),
    ]);
    expect(episodeActions(two[0])).toContain("1 other kind of access");
    const three = groupIntoEpisodes([
      row("a", "raw_namespace_listed", t("04:46:00")),
      row("a", "vault_blob_read", t("04:45:00")),
      row("a", "raw_object_read", t("04:44:00")),
    ]);
    expect(episodeActions(three[0])).toContain("2 other kinds of access");
  });
});

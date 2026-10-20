<script lang="ts">
  // The whole answer to "who can read my record", on one page.
  //
  // It was two modals that could not both be open: one listed who has access, the other — four
  // screens down, under Account — held LexiTar's own recovery key and the log of who had actually
  // opened the record. A patient asking one question had to know it was two. Worse, the sign-in
  // methods beside them used the same row markup, so a stored password rendered identically to a
  // human being with access to a medical record.
  //
  // So: three bands, in the order the questions are asked — what needs me, who can read it, who
  // did read it — and one row shape for every principal, whatever it is. The password stayed in
  // Account, where it belongs, because there is nobody at the other end of it.
  import PrincipalRow from "@tinytars/frame/PrincipalRow.svelte";
  import DurationChoice from "@tinytars/frame/DurationChoice.svelte";
  import Button from "@tinytars/frame/Button.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import type { VaultPrincipals } from "@tinytars/frame/vault-principals.svelte";
  import type { ProviderLinkView } from "@tinytars/vault/auth-grants";
  import AccessLog from "./AccessLog.svelte";
  import type { AccessEpisode } from "./access-episodes";
  import { KIND_CHIP, YOU_SENTENCE, grantSentence, kindOf, pendingSentence, recoverySentence } from "./access-vocabulary";

  interface Props {
    access: VaultPrincipals;
    /** The owner's own name for the YOU row — their display name, or their email as it falls back. */
    ownerName: string;
    /**
     * False in a provider session, which is the one case where this panel has no owner: a clinician
     * managing their own access to someone else's record has no recovery key and no disclosure log.
     */
    isOwner: boolean;
    /** The recovery-key principal, as much of the controller as this row acts on. */
    recovery: { orgHeld: boolean; orgRevokedAt: string | null; revokeConfirm: boolean; revokeOrgKey: () => void };
    /** The Account modal's busy flag, which is what `revokeOrgKey` runs under. */
    recoveryBusy: boolean;
    /** LexiTar's own uses of the recovery key, and everybody else's visits. */
    orgKeyEpisodes: AccessEpisode[];
    otherEpisodes: AccessEpisode[];
    nameFor: (actorAccountId: string) => string;
    onReport: (linkId: string) => void;
    /** Injected so a test can pin every date; the panel is short-lived, so reading it once is enough. */
    now?: number;
  }
  let { access, ownerName, isOwner, recovery, recoveryBusy, orgKeyEpisodes, otherEpisodes, nameFor, onReport, now = Date.now() }: Props = $props();

  const DAY_HOURS = 24;
  const MONTH_HOURS = 30 * DAY_HOURS;

  // Two different questions wearing the same control. A clinician is being given a standing
  // relationship, so the choice is "how long before I think about this again" and the alternative
  // is not thinking about it. Support is break-glass: the windows are short on purpose and
  // "ongoing" is not among them.
  const durationOptions = (p: ProviderLinkView) =>
    kindOf(p) === "support"
      ? [
          { label: "24 hours", hours: DAY_HOURS },
          { label: "3 days", hours: 3 * DAY_HOURS },
          { label: "7 days", hours: 7 * DAY_HOURS },
        ]
      : [
          { label: "30 days", hours: MONTH_HOURS },
          { label: "Ongoing", hours: 0 },
        ];

  const reportItem = (p: ProviderLinkView): LeafMenuItem => ({
    // 9C.2 — reporting is the thing revoking is not: revoking ends their access to this record and
    // says nothing to anyone about why.
    label: "Report this account",
    onClick: () => onReport(p.linkId),
  });

  const revokeItem = (p: ProviderLinkView): LeafMenuItem => ({
    label: "Revoke access",
    danger: true,
    disabled: access.busy,
    onClick: () => access.revoke(p),
  });

  // Changing a live consent window is a named decision in a menu, never a dropdown that commits as
  // it is read. Which names appear depends on where the window already is: offering "Make ongoing"
  // to a grant that is already ongoing is an instruction to do nothing.
  function activeItems(p: ProviderLinkView): LeafMenuItem[] {
    const retime: LeafMenuItem[] = p.expiresAt
      ? [
          { label: "Extend 30 days", disabled: access.busy, onClick: () => access.renew(p, 30) },
          { label: "Make ongoing", disabled: access.busy, onClick: () => access.renew(p, null) },
        ]
      : [{ label: "Set a 30-day limit", disabled: access.busy, onClick: () => access.renew(p, 30) }];
    return [...retime, revokeItem(p), reportItem(p)];
  }

  // The last week is the only state the owner can still act on before something is lost, so it is
  // the only one that gets a button of its own rather than a line in a menu.
  const endingSoon = (p: ProviderLinkView) => grantSentence(p, now).tone === "warn";

  const nobodyElse = $derived(access.activeAccess.length === 0 && access.endedAccess.length === 0);
</script>

<div class="access-panel">
  {#if access.pendingRequests.length > 0}
    <section class="band" aria-labelledby="band-waiting">
      <h3 class="access-subhead" id="band-waiting">Waiting on you</h3>
      {#each access.pendingRequests as p (p.linkId)}
        <PrincipalRow
          testid="access-pending-row"
          chip={KIND_CHIP[kindOf(p)]}
          name={p.displayName}
          detail={pendingSentence(p).text}
          primary={{ label: "Approve", disabled: access.busy, onClick: () => access.approve(p), testid: "access-approve" }}
          secondary={{ label: "Deny", disabled: access.busy, onClick: () => access.revoke(p), testid: "access-deny" }}
          items={[reportItem(p)]}
        >
          <div class="row-choice">
            <DurationChoice
              legend={`How long should ${p.displayName} have access?`}
              name={`duration-${p.linkId}`}
              options={durationOptions(p)}
              value={access.chosenHours(p)}
              onChange={(h) => access.setChosenHours(p.linkId, h)}
            />
          </div>
        </PrincipalRow>
      {/each}
    </section>
  {/if}

  <section class="band" aria-labelledby="band-who">
    <h3 class="access-subhead" id="band-who">Who can read your record</h3>

    {#if isOwner}
      <PrincipalRow testid="access-you-row" chip={KIND_CHIP.you} name={ownerName} detail={YOU_SENTENCE.text} />
    {/if}

    {#each access.activeAccess as p (p.linkId)}
      {@const sentence = grantSentence(p, now)}
      <PrincipalRow
        testid="access-active-row"
        chip={KIND_CHIP[kindOf(p)]}
        name={p.displayName}
        detail={sentence.text}
        detailTone={sentence.tone}
        primary={endingSoon(p) ? { label: "Renew for 30 days", disabled: access.busy, onClick: () => access.renew(p, 30), testid: "access-renew" } : undefined}
        items={activeItems(p)}
      />
    {/each}

    {#if isOwner}
      <PrincipalRow
        testid="access-recovery-row"
        chip={KIND_CHIP.recovery}
        name="LexiTar's recovery key"
        dimmed={!recovery.orgHeld}
        detail={recoverySentence(recovery.orgHeld, recovery.orgRevokedAt, orgKeyEpisodes.length, now).text}
        items={recovery.orgHeld && !recovery.revokeConfirm
          ? [{ label: "Remove recovery key", danger: true, disabled: recoveryBusy, onClick: () => (recovery.revokeConfirm = true) }]
          : []}
      >
        {#if recovery.revokeConfirm}
          <p class="confirm">
            Remove the recovery key? Your record stays encrypted with your password alone. If you
            forget it, nobody can recover this record — not you, not LexiTar.
          </p>
          <div class="row-choice">
            <Button class="ap-danger" disabled={recoveryBusy} onclick={() => recovery.revokeOrgKey()}>Yes, remove it</Button>
            <Button disabled={recoveryBusy} onclick={() => (recovery.revokeConfirm = false)}>Cancel</Button>
          </div>
        {/if}
        <!-- The sentence above promises every use is listed, so the list is in the row that makes
             the promise rather than under a heading somewhere below it. -->
        <details class="row-log">
          <summary>Every use of this key</summary>
          <AccessLog episodes={orgKeyEpisodes} {nameFor} emptyText="LexiTar has never used this key on your record." />
        </details>
      </PrincipalRow>
    {/if}

    {#each access.endedAccess as p (p.linkId)}
      <PrincipalRow
        testid="access-ended-row"
        chip={KIND_CHIP[kindOf(p)]}
        name={p.displayName}
        dimmed
        detail={grantSentence(p, now).text}
        primary={{ label: "Renew", disabled: access.busy, onClick: () => access.renew(p, 30), testid: "access-renew" }}
        items={[
          { label: "Remove from this list", disabled: access.busy, onClick: () => access.revoke(p) },
          reportItem(p),
        ]}
      />
    {/each}

    {#if nobodyElse}
      <p class="access-intro" data-testid="access-empty">Only you.</p>
    {/if}

    <form class="access-add" onsubmit={(e) => { e.preventDefault(); access.addProvider(); }}>
      <label class="add-label" for="access-add-email">Share this record with a clinician</label>
      <span class="add-row">
        <input id="access-add-email" type="email" placeholder="provider@example.com" bind:value={access.newProviderEmail} disabled={access.busy} />
        <Button type="submit" data-testid="access-add-btn" primary disabled={access.busy || !access.newProviderEmail.trim()}>Add provider</Button>
      </span>
      <p class="access-intro">They are asked to accept, and get 30 days unless you choose otherwise.</p>
    </form>

    {#if access.error}<p class="access-error">{access.error}</p>{/if}
  </section>

  {#if isOwner}
    <section class="band" aria-labelledby="band-read">
      <h3 class="access-subhead" id="band-read">Who has read your record</h3>
      <p class="access-intro">
        Everyone other than you who has opened this record, newest first — one line per visit. Your
        own reading of your record is never listed here. Open a line to see each thing that was read.
      </p>
      <AccessLog episodes={otherEpisodes} {nameFor} emptyText="Nobody else has opened your record." />
    </section>
  {/if}
</div>

<style>
  .band { margin-bottom: 1.4rem; }
  .band:last-child { margin-bottom: 0; }
  .access-subhead { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 0.5rem; }
  .row-choice { display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0 0.3rem 0.5rem; }
  .confirm { margin: 0 0.3rem 0.45rem; font-size: 0.85rem; color: var(--warn); }
  .row-log { margin: 0 0.3rem 0.4rem; }
  .row-log summary { font-size: 0.8rem; color: var(--muted); cursor: pointer; }
  .access-add { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.9rem; }
  .add-label { font-size: 0.85rem; font-weight: 600; }
  .add-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .add-row input { flex: 1 1 14rem; font: inherit; font-size: 0.9rem; padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: 6px; }
  .access-intro { margin: 0; font-size: 0.85rem; color: var(--muted); }
  .access-error { margin: 0.6rem 0 0; font-size: 0.85rem; color: var(--warn); }
  /* The confirm button's own variant rather than Modal's `btn danger`, which no stylesheet in
     either package defines — a red-looking name is not a red button. */
  :global(.btn.ap-danger) { border-color: var(--alert); color: var(--alert); }
</style>

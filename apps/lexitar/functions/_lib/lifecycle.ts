import { canTransition, stageForEvent } from "../../src/lib/lifecycle";
import type { D1Database } from "./identity-types";
import { getAccount, setLifecycleStage } from "./identity-accounts";
import { insertCrmEvent, type CrmEvent } from "./identity-audit";

// W44 P5 — the single lifecycle event seam. Every account stage change flows through here: it records
// the event to crm_events and advances the account's stage on a valid transition (a bad transition is
// still recorded, with meta.rejectedTarget, but leaves the stage unchanged).
//
// FUTURE (later milestone — STUBBED here, no external calls fire): fan out to Stripe subscription state
// and the Salesforce Agentforce Nonprofit sync. §E object map: waitlist/lead → SF Lead; account
// creation/confirmation → convert to Contact; first recurring payment → GiftCommitment (the object the
// donation stack already uses, donation-stack-plan.md:41); churn → close the commitment. Because
// payments are Stripe-direct, a Stripe webhook → Apex REST endpoint owns the GiftCommitment upsert (the
// role Every.org's webhook played). Upstream lead source: the tinytars waitlist (waitlist-admin.ts) —
// no cross-app transport exists yet, so waitlist_joined/lead_captured are a noted, deferred seam.
export async function emitLifecycleEvent(
  db: D1Database,
  accountId: string,
  event: string,
  meta: Record<string, unknown> = {},
): Promise<CrmEvent | null> {
  const account = await getAccount(db, accountId);
  if (!account) return null;

  const from = account.lifecycleStage;
  const target = stageForEvent(event);
  let stageTo = from;
  let recordedMeta: Record<string, unknown> = meta;

  if (target && target !== from) {
    if (canTransition(from, target)) {
      await setLifecycleStage(db, accountId, target);
      stageTo = target;
    } else {
      recordedMeta = { ...meta, rejectedTarget: target };
    }
  }

  return insertCrmEvent(db, { accountId, event, stageFrom: from, stageTo, meta: recordedMeta });
}

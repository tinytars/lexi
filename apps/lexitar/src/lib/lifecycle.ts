// W44 P5 — the account lifecycle stage machine (pure; no D1/fetch/DOM, mirrors the src/lib/staleness.ts
// pattern so it's unit-testable in isolation). The D1 writer + event recording live in
// functions/_lib/lifecycle.ts (emitLifecycleEvent), which imports this module.

export type LifecycleStage = "waitlist" | "lead" | "active" | "paying" | "churned";

export const LIFECYCLE_STAGES: LifecycleStage[] = ["waitlist", "lead", "active", "paying", "churned"];

// Directed valid transitions between stages. A new account (stageFrom === null) may enter at
// waitlist/lead/active (see canTransition). churned → active models reactivation; paying → active a
// downgrade. Anything not listed (e.g. active → waitlist, churned → paying) is rejected.
const TRANSITIONS: Record<LifecycleStage, LifecycleStage[]> = {
  waitlist: ["lead", "active", "churned"],
  lead: ["active", "churned"],
  active: ["paying", "churned"],
  paying: ["active", "churned"],
  churned: ["active"],
};

export function canTransition(from: LifecycleStage | null, to: LifecycleStage): boolean {
  if (from === to) return true; // idempotent (record-only, no stage change)
  if (from === null) return to === "waitlist" || to === "lead" || to === "active";
  return TRANSITIONS[from].includes(to);
}

// Maps a lifecycle event name to the stage it drives to, or null for a record-only event (no stage
// change — e.g. email_confirmed) and for unknown events. payment_/subscription_ events are the
// (future) Stripe-driven ones; they're mapped here but the fan-out that emits them isn't built (P5).
const EVENT_STAGE: Record<string, LifecycleStage | null> = {
  waitlist_joined: "waitlist",
  lead_captured: "lead",
  signup: "active",
  account_created: "active",
  payment_succeeded: "paying",
  subscription_canceled: "churned",
  dunning_failed: "churned",
  email_confirmed: null,
};

export function stageForEvent(event: string): LifecycleStage | null {
  return EVENT_STAGE[event] ?? null;
}

// Events that change billing-derived stages — these are driven by the (unbuilt) Stripe webhook, never
// by a client. The stub /api/crm/event rejects them so a client can't self-promote to `paying`.
export function isBillingDrivenEvent(event: string): boolean {
  const s = stageForEvent(event);
  return s === "paying" || s === "churned";
}

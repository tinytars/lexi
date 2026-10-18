import { describe, it, expect } from "vitest";
import { canTransition, stageForEvent, isBillingDrivenEvent, LIFECYCLE_STAGES } from "../../src/lib/lifecycle";

describe("lifecycle stage machine", () => {
  it("has the five stages in order", () => {
    expect(LIFECYCLE_STAGES).toEqual(["waitlist", "lead", "active", "paying", "churned"]);
  });

  it("allows a new account (null) to enter at waitlist/lead/active only", () => {
    expect(canTransition(null, "waitlist")).toBe(true);
    expect(canTransition(null, "lead")).toBe(true);
    expect(canTransition(null, "active")).toBe(true);
    expect(canTransition(null, "paying")).toBe(false);
    expect(canTransition(null, "churned")).toBe(false);
  });

  it("allows the forward path and legal skips", () => {
    expect(canTransition("waitlist", "lead")).toBe(true);
    expect(canTransition("lead", "active")).toBe(true);
    expect(canTransition("active", "paying")).toBe(true);
    expect(canTransition("paying", "active")).toBe(true); // downgrade
    expect(canTransition("churned", "active")).toBe(true); // reactivation
    expect(canTransition("active", "churned")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("churned", "paying")).toBe(false);
    expect(canTransition("active", "waitlist")).toBe(false);
    expect(canTransition("lead", "paying")).toBe(false);
  });

  it("treats a same-stage transition as valid (idempotent record-only)", () => {
    expect(canTransition("active", "active")).toBe(true);
  });

  it("maps events to stages, with record-only/unknown → null", () => {
    expect(stageForEvent("signup")).toBe("active");
    expect(stageForEvent("account_created")).toBe("active");
    expect(stageForEvent("waitlist_joined")).toBe("waitlist");
    expect(stageForEvent("lead_captured")).toBe("lead");
    expect(stageForEvent("payment_succeeded")).toBe("paying");
    expect(stageForEvent("subscription_canceled")).toBe("churned");
    expect(stageForEvent("email_confirmed")).toBeNull();
    expect(stageForEvent("totally_unknown")).toBeNull();
  });

  it("flags billing-driven events (paying/churned) that must come from the webhook", () => {
    expect(isBillingDrivenEvent("payment_succeeded")).toBe(true);
    expect(isBillingDrivenEvent("subscription_canceled")).toBe(true);
    expect(isBillingDrivenEvent("dunning_failed")).toBe(true);
    expect(isBillingDrivenEvent("signup")).toBe(false);
    expect(isBillingDrivenEvent("lead_captured")).toBe(false);
  });
});

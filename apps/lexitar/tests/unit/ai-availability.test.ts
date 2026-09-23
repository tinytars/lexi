import { describe, it, expect, beforeEach } from "vitest";
import { aiAvailability } from "../../src/lib/ai-availability.svelte";

// The latch is a module singleton (see its header), so each test returns it to "nothing is wrong"
// through the same door the app uses: a successful probe route.
beforeEach(() => aiAvailability.observe("/api/leaf-regen", 200));

describe("aiAvailability", () => {
  it("is quiet and lets background work through until something answers 402", () => {
    expect(aiAvailability.outOfCredit).toBe(false);
    expect(aiAvailability.mayProbe()).toBe(true);
    expect(aiAvailability.mayProbe()).toBe(true);
  });

  it("raises on a 402 from any api route and halts background work", () => {
    aiAvailability.observe("/api/corpus-warm", 402);
    expect(aiAvailability.outOfCredit).toBe(true);
    expect(aiAvailability.mayProbe()).toBe(false);
  });

  it("grants exactly one probe per presence signal", () => {
    aiAvailability.observe("/api/leaf-regen", 402);
    aiAvailability.rearm();
    expect(aiAvailability.mayProbe()).toBe(true);
    expect(aiAvailability.mayProbe()).toBe(false);
  });

  it("does not stack probes when presence is signalled repeatedly", () => {
    aiAvailability.observe("/api/leaf-regen", 402);
    aiAvailability.rearm();
    aiAvailability.rearm();
    expect(aiAvailability.mayProbe()).toBe(true);
    expect(aiAvailability.mayProbe()).toBe(false);
  });

  it("spends the granted probe when the probe itself is refused again", () => {
    aiAvailability.observe("/api/leaf-regen", 402);
    aiAvailability.rearm();
    expect(aiAvailability.mayProbe()).toBe(true);
    aiAvailability.observe("/api/leaf-regen", 402);
    expect(aiAvailability.outOfCredit).toBe(true);
    expect(aiAvailability.mayProbe()).toBe(false);
  });

  it.each(["/api/leaf-regen", "/api/chat"])("lowers when %s succeeds — a 2xx there was a paid call", (route) => {
    aiAvailability.observe("/api/corpus-warm", 402);
    aiAvailability.observe(route, 200);
    expect(aiAvailability.outOfCredit).toBe(false);
    expect(aiAvailability.mayProbe()).toBe(true);
  });

  // The badge must not clear because an unrelated request happened to work: a vault PUT proves the
  // app is online, which was never the question.
  it("stays raised when a route that is not a probe succeeds", () => {
    aiAvailability.observe("/api/leaf-regen", 402);
    aiAvailability.observe("/api/vault/abc", 200);
    expect(aiAvailability.outOfCredit).toBe(true);
  });

  // functions/api/corpus-warm.ts:67,72,78 answer 200 for `off`, `unsupported` and `no_corpus`
  // without calling the provider, so a warm that "worked" is no evidence the account has credit.
  it("stays raised when a warm succeeds, because a warm can succeed without paying", () => {
    aiAvailability.observe("/api/leaf-regen", 402);
    aiAvailability.observe("/api/corpus-warm", 200);
    expect(aiAvailability.outOfCredit).toBe(true);
  });

  it("stays raised when a probe route answers a non-2xx", () => {
    aiAvailability.observe("/api/leaf-regen", 402);
    aiAvailability.observe("/api/leaf-regen", 503);
    expect(aiAvailability.outOfCredit).toBe(true);
  });
});

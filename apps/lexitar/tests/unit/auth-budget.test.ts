import { describe, it, expect } from "vitest";
import { spendAuthBudget, forgiveAuthAttempt, COST_LOGIN, COST_SALT } from "../../functions/_lib/auth-budget";
import { useWorkerd } from "../support/miniflare";
import { SqliteD1Database } from "../../server/sqlite-d1";

// Mirrors tests/unit/report-budget.test.ts, including its per-test-window discipline: the global cap is
// shared, so two tests in one window would cap each other. Here a window is ten minutes, so `at` steps
// by ten minutes rather than by the hour.
const d1 = useWorkerd();
const env = { SESSION_SECRET: "test-secret" };
const at = (w: number) => new Date(Date.UTC(2026, 8, 20, 0, 10 * w, 0));
const spend = (ip: string | null, email: string, now: Date, cost = COST_LOGIN) =>
  spendAuthBudget(d1.db, env, { ip, email, cost, now });
const forgive = (ip: string, email: string, now: Date, cost = COST_LOGIN) =>
  forgiveAuthAttempt(d1.db, env, { ip, email, cost, now });

describe("spendAuthBudget", () => {
  it("allows an address its window and then stops", async () => {
    const now = at(1);
    // Twenty per address, each attempt against a different account so the per-email cap is not what fires.
    for (let i = 0; i < 20; i++) expect((await spend("198.51.100.1", `a${i}@x.test`, now)).allowed, `attempt ${i + 1}`).toBe(true);
    expect(await spend("198.51.100.1", "a99@x.test", now)).toMatchObject({ allowed: false, reason: "per_ip" });
  });

  it("charges the attempt that was refused, so retrying cannot walk back under the cap", async () => {
    const now = at(2);
    for (let i = 0; i < 10; i++) await spend("198.51.100.2", "b@x.test", now);
    expect((await spend("198.51.100.2", "b@x.test", now)).allowed).toBe(false);
    expect((await spend("198.51.100.2", "b@x.test", now)).allowed).toBe(false);
  });

  it("gives the next window a fresh budget", async () => {
    for (let i = 0; i < 10; i++) await spend("198.51.100.3", "c@x.test", at(3));
    expect((await spend("198.51.100.3", "c@x.test", at(3))).allowed).toBe(false);
    expect((await spend("198.51.100.3", "c@x.test", at(4))).allowed).toBe(true);
  });

  it("caps one address across many accounts, which is a network walking an address book", async () => {
    const now = at(5);
    for (let i = 0; i < 10; i++) await spend("198.51.100.4", `d${i}@x.test`, now);
    // Ten distinct accounts, so no email bucket is near its cap — only the shared address bucket is.
    for (let i = 10; i < 20; i++) await spend("198.51.100.4", `d${i}@x.test`, now);
    expect(await spend("198.51.100.4", "d99@x.test", now)).toMatchObject({ allowed: false, reason: "per_ip" });
  });

  it("caps one account across many addresses, which is a botnet on one target", async () => {
    const now = at(6);
    for (let i = 0; i < 10; i++) expect((await spend(`203.0.113.${i}`, "target@x.test", now)).allowed).toBe(true);
    expect(await spend("203.0.113.99", "target@x.test", now)).toMatchObject({ allowed: false, reason: "per_email" });
  });

  it("budgets each address separately, so one flood cannot starve a real user", async () => {
    const now = at(7);
    for (let i = 0; i < 20; i++) await spend("198.51.100.5", `e${i}@x.test`, now);
    expect((await spend("198.51.100.6", "innocent@x.test", now)).allowed).toBe(true);
  });

  it("holds every caller the platform gave us no address for to the strictest cap", async () => {
    const now = at(8);
    for (let i = 0; i < 5; i++) expect((await spend(null, `f${i}@x.test`, now)).allowed, `attempt ${i + 1}`).toBe(true);
    expect((await spend(null, "f99@x.test", now)).allowed).toBe(false);
  });

  it("charges a salt probe half of a sign-in attempt", async () => {
    const now = at(9);
    // Ten probes against one account spend five attempts' worth, so the cap has not fired yet.
    for (let i = 0; i < 10; i++) expect((await spend("198.51.100.7", "g@x.test", now, COST_SALT)).allowed).toBe(true);
    for (let i = 0; i < 5; i++) expect((await spend("198.51.100.7", "g@x.test", now, COST_LOGIN)).allowed).toBe(true);
    expect(await spend("198.51.100.7", "g@x.test", now, COST_LOGIN)).toMatchObject({ allowed: false, reason: "per_email" });
  });

  it("says how long to wait, which is the rest of the window", async () => {
    const now = new Date(Date.UTC(2026, 8, 20, 3, 34, 0)); // 4 minutes into the window that began at 3:30
    for (let i = 0; i < 10; i++) await spend("198.51.100.8", "h@x.test", now);
    const refused = await spend("198.51.100.8", "h@x.test", now);
    expect(refused).toMatchObject({ allowed: false, retryAfterSeconds: 360 });
  });

  it("folds case, so a guesser cannot double a budget by capitalising the address", async () => {
    const now = at(11);
    for (let i = 0; i < 10; i++) await spend(`203.0.113.${i}`, "mixed@x.test", now);
    expect((await spend("203.0.113.98", "MiXeD@X.test", now)).allowed).toBe(false);
  });

  it("clears that email's bucket on a correct sign-in, so a person who mistyped is not locked out", async () => {
    const now = at(12);
    // Each from a different address, so the per-email cap is the only one in play.
    for (let i = 0; i < 10; i++) await spend(`203.0.113.${i}`, "right@x.test", now);
    expect((await spend("203.0.113.50", "right@x.test", now)).allowed).toBe(false);

    await forgive("203.0.113.50", "right@x.test", now);
    for (let i = 0; i < 10; i++) expect((await spend(`203.0.113.${i}`, "right@x.test", now)).allowed, `after ${i}`).toBe(true);
  });

  it("refunds the correct attempt to the address and not a single one more", async () => {
    const now = at(16);
    // Twenty attempts from one address is exactly its cap; distinct accounts so per-email cannot fire.
    for (let i = 0; i < 20; i++) expect((await spend("198.51.100.9", `k${i}@x.test`, now)).allowed, `attempt ${i + 1}`).toBe(true);

    // Forgiven at the cap, not after a refusal: a refusal is charged too (that is the point of charging
    // before the verdict), so it would spend the refund the moment it arrived.
    await forgive("198.51.100.9", "k0@x.test", now);
    // One attempt came back — and only one, which is what separates a refund from clearing the bucket.
    expect((await spend("198.51.100.9", "k97@x.test", now)).allowed).toBe(true);
    expect((await spend("198.51.100.9", "k96@x.test", now)).allowed).toBe(false);
  });

  it("cannot be refunded below zero into free attempts", async () => {
    const now = at(17);
    await spend("198.51.100.11", "l@x.test", now);
    // Ten forgivenesses for one attempt, as a retry or a double-call would produce.
    for (let i = 0; i < 10; i++) await forgive("198.51.100.11", "l@x.test", now);
    for (let i = 0; i < 20; i++) expect((await spend("198.51.100.11", `m${i}@x.test`, now)).allowed, `attempt ${i + 1}`).toBe(true);
    expect((await spend("198.51.100.11", "m98@x.test", now)).allowed).toBe(false);
  });

  it("stores a keyed hash and never the address or the email", async () => {
    await spend("198.51.100.77", "secret-person@x.test", at(13));
    const { results } = await d1.db.prepare("SELECT bucket FROM auth_attempt_budget").all<{ bucket: string }>();
    expect(results.length).toBeGreaterThan(0);
    expect(JSON.stringify(results)).not.toContain("198.51.100.77");
    expect(JSON.stringify(results)).not.toContain("secret-person");
  });

  it("allows rather than throws when the table cannot be reached — a lockout is worse than the attack", async () => {
    // The deliberate opposite of report-budget's verdict on the same failure: there an uncountable
    // anonymous write path is unbounded, here it is a family locked out of their own health record.
    const broken = new SqliteD1Database(":memory:");
    expect(await spendAuthBudget(broken, env, { ip: "198.51.100.10", email: "i@x.test", cost: COST_LOGIN, now: at(14) })).toEqual({ allowed: true });
    broken.close();
  });

  it("does not fail a sign-in when the forgiveness cannot reach the table", async () => {
    const broken = new SqliteD1Database(":memory:");
    await expect(
      forgiveAuthAttempt(broken, env, { ip: "198.51.100.12", email: "j@x.test", cost: COST_LOGIN, now: at(15) }),
    ).resolves.toBeUndefined();
    broken.close();
  });
});

import { describe, it, expect } from "vitest";
import { spendReportBudget } from "../../functions/_lib/report-budget";
import { useWorkerd } from "../support/miniflare";
import { SqliteD1Database } from "../../server/sqlite-d1";

// What stands in for the session check now that /api/client-error accepts anonymous reports.
// Every test picks its own hour: the global cap is shared, so tests that shared one would cap each other.

const d1 = useWorkerd();
const env = { SESSION_SECRET: "test-secret" };
const at = (hour: number) => new Date(`2026-09-20T${String(hour).padStart(2, "0")}:00:00Z`);
const spend = (ip: string | null, cost: number, now: Date) => spendReportBudget(d1.db, env, ip, cost, now);

describe("spendReportBudget", () => {
  it("allows an address its hour and then stops", async () => {
    const now = at(1);
    for (let i = 0; i < 5; i++) expect((await spend("198.51.100.1", 1, now)).allowed, `report ${i + 1}`).toBe(true);
    expect(await spend("198.51.100.1", 1, now)).toEqual({ allowed: false, reason: "per_ip" });
  });

  it("charges the attempt that was refused, so retrying cannot walk back under the cap", async () => {
    const now = at(2);
    await spend("198.51.100.2", 5, now);
    expect((await spend("198.51.100.2", 1, now)).allowed).toBe(false);
    expect((await spend("198.51.100.2", 1, now)).allowed).toBe(false);
  });

  it("gives the next hour a fresh budget", async () => {
    await spend("198.51.100.3", 5, at(3));
    expect((await spend("198.51.100.3", 1, at(3))).allowed).toBe(false);
    expect((await spend("198.51.100.3", 1, at(4))).allowed).toBe(true);
  });

  it("budgets each address separately, so one flood cannot starve a real user", async () => {
    const now = at(5);
    await spend("198.51.100.4", 5, now);
    expect((await spend("198.51.100.5", 1, now)).allowed).toBe(true);
  });

  it("caps the whole hour too, for an attacker who rotates addresses", async () => {
    const now = at(6);
    for (let i = 0; i < 5; i++) await spend(`203.0.113.${i}`, 4, now);
    expect(await spend("203.0.113.99", 1, now)).toEqual({ allowed: false, reason: "global" });
  });

  it("holds every caller the platform gave us no address for to the strictest cap", async () => {
    const now = at(7);
    expect((await spend(null, 1, now)).allowed).toBe(true);
    expect((await spend(null, 1, now)).allowed).toBe(true);
    expect((await spend(null, 1, now)).allowed).toBe(false);
  });

  it("stores a keyed hash of the address and never the address", async () => {
    await spend("198.51.100.77", 1, at(8));
    const { results } = await d1.db.prepare("SELECT bucket FROM error_report_budget").all<{ bucket: string }>();
    expect(results.length).toBeGreaterThan(0);
    expect(JSON.stringify(results)).not.toContain("198.51.100.77");
  });

  it("denies rather than throws when the table cannot be reached — an uncountable path is unbounded", async () => {
    const broken = new SqliteD1Database(":memory:");
    expect(await spendReportBudget(broken, env, "198.51.100.8", 1, at(9))).toEqual({ allowed: false, reason: "unavailable" });
    broken.close();
  });
});

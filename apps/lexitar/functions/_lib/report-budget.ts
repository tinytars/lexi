import type { D1Database } from "./identity-types";

// What stands in for the session check on the anonymous /api/client-error path: without a session
// there is nothing to rate-limit by but the caller's address, and an address is PII in a health app —
// so a row is keyed by HMAC(SESSION_SECRET, ip), never by the address itself. Rows expire by being
// ignored (the hour is part of the key) and are pruned opportunistically.

export interface ReportBudgetEnv {
  SESSION_SECRET: string;
}

const HOUR_MS = 3_600_000;
const PER_IP_HOUR = 5;
// Every caller whose address the platform did not give us shares one bucket, so it gets the strict cap.
const NO_IP_HOUR = 2;
const GLOBAL_HOUR = 20;
const PRUNE_ODDS = 50;

const enc = new TextEncoder();

export interface BudgetVerdict {
  allowed: boolean;
  reason?: "per_ip" | "global" | "unavailable";
}

async function bucketFor(secret: string, ip: string | null, hour: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`report-budget:${ip ?? ""}`)));
  return `${[...sig.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}:${hour}`;
}

async function spend(db: D1Database, bucket: string, hour: number, cost: number): Promise<number> {
  const row = await db
    .prepare("INSERT INTO error_report_budget (bucket, hour, n) VALUES (?1, ?2, ?3) ON CONFLICT(bucket) DO UPDATE SET n = n + ?3 RETURNING n")
    .bind(bucket, hour, cost)
    .first<{ n: number }>();
  return row?.n ?? cost;
}

/**
 * Charges `cost` against this caller's hour and the global hour, and says whether the report may be
 * filed. The attempt is always recorded, so a rejected caller cannot retry its way back under the cap.
 * Never throws: a D1 failure denies (an uncountable anonymous write path is an unbounded one).
 */
export async function spendReportBudget(
  db: D1Database,
  env: ReportBudgetEnv,
  ip: string | null,
  cost: number,
  now: Date = new Date(),
): Promise<BudgetVerdict> {
  const hour = Math.floor(now.getTime() / HOUR_MS);
  try {
    const mine = await spend(db, await bucketFor(env.SESSION_SECRET, ip, hour), hour, cost);
    const all = await spend(db, `*:${hour}`, hour, cost);
    if (Math.random() * PRUNE_ODDS < 1) await db.prepare("DELETE FROM error_report_budget WHERE hour < ?1").bind(hour - 1).run();
    if (mine > (ip ? PER_IP_HOUR : NO_IP_HOUR)) return { allowed: false, reason: "per_ip" };
    if (all > GLOBAL_HOUR) return { allowed: false, reason: "global" };
    return { allowed: true };
  } catch (e) {
    console.error("report budget unavailable", (e as Error).message);
    return { allowed: false, reason: "unavailable" };
  }
}

import type { D1Database } from "./identity-types";
import { json } from "./http";

// The counter password sign-in has never had. Until now `/api/auth/password/login` and its `salt`
// companion had no cap, lockout, backoff or delay of any kind, and the expensive half of the check —
// 200,000 PBKDF2 iterations — runs in the guesser's own browser, so each attempt cost the service one
// hash and two indexed reads. That is the wrong way round.
//
// Modelled on `functions/_lib/report-budget.ts`: the same HMAC-keyed bucket, the same atomic
// `INSERT … ON CONFLICT … RETURNING n`, the attempt charged BEFORE the verdict so a refused caller
// cannot retry its way back under the cap, the same opportunistic prune. Four divergences, each for a
// reason that template does not share:
//
// TWO BUCKET KINDS, ADDRESS AND EMAIL. Per-address alone lets a botnet spread one address book across
// many networks; per-email alone lets one network walk an address book. Neither substitutes for the other.
//
// A TEN-MINUTE WINDOW, NOT AN HOUR. An error report is occasional; a person who mistyped their password
// wants to retry in seconds. Ten minutes gives someone locked out a short wait and still caps a guesser.
//
// A SUCCESSFUL SIGN-IN IS FORGIVEN IN FULL, and "in full" is load-bearing. Every bucket here counts
// FAILURES, never traffic: a client cannot choose its own address (the edge overwrites
// `cf-connecting-ip`), so a household, a clinic and a browser test suite all arrive as ONE address, and
// any per-success cost at all caps them however many of their sign-ins were correct. So the email bucket
// is cleared outright, and the address and global buckets get the whole `COST_SIGNIN` pair back —
// refunding the login but not the salt probe still charges for succeeding, which is what cost this
// repository's browser suite its 38th test. A refund is not a clear: every failed guess from that
// address stays counted, so the guesser's meter keeps running while the family's never starts.
//
// IT FAILS OPEN, where `report-budget.ts` fails closed and is right to: there the worst case is a lost
// error report. Here it is every patient locked out of their own record — including the patient who
// needs their access screen to revoke someone. Availability of the record is itself a safety property of
// this application. The residual is bounded and deliberate: an attacker who can induce database errors
// gets an unthrottled route, but still pays the client-side derivation per guess and still cannot pass
// the stored verifier.
//
// The table holds HMAC-keyed 8-byte buckets and no address, no email address and no health data.
// Rotating SESSION_SECRET silently resets every bucket, which forgets attempts rather than granting any.

export interface AuthBudgetEnv {
  SESSION_SECRET: string;
}

const WINDOW_MS = 600_000; // ten minutes
const PRUNE_ODDS = 50;

/**
 * One sign-in attempt. A salt probe costs half of one, which is the whole reason the unit is 2: `n` is
 * an integer column, so "half an attempt" has to be expressed by making an attempt worth two.
 */
export const COST_LOGIN = 2;
/** The reconnaissance half of the pair — it already returns a decoy, so volume is what the cap limits. */
export const COST_SALT = 1;
/** One whole sign-in: the salt probe the browser makes and the login that follows it. What success costs. */
export const COST_SIGNIN = COST_LOGIN + COST_SALT;

// Deliberately generous to start, because there is no live tuning: `wrangler.jsonc` has no key-value or
// analytics binding, so changing a cap is a redeploy.
const PER_IP = 20 * COST_LOGIN;
const PER_EMAIL = 10 * COST_LOGIN;
/** Every caller the platform gave us no address for shares one bucket, so it gets the strict cap. */
const NO_IP = 5 * COST_LOGIN;
/** Exported so its test can seed the bucket up to it, rather than spending 200 real sign-ins reaching it. */
export const GLOBAL = 300 * COST_LOGIN;

const enc = new TextEncoder();

export type AuthBudgetVerdict =
  | { allowed: true }
  | { allowed: false; reason: "per_ip" | "per_email" | "global"; retryAfterSeconds: number };

/** The error code the 429 carries. Which cap fired is logged, never returned — see `tooManyAttempts`. */
export const TOO_MANY_ATTEMPTS = "too_many_attempts";

/**
 * The refusal, identical for every caller. It names no cap and no account, so it cannot become the
 * account oracle that `login.ts`'s uniform 401 and `salt.ts`'s decoy exist to deny.
 */
export const tooManyAttempts = (retryAfterSeconds: number): Response =>
  json(429, { error: "too many attempts", errorCode: TOO_MANY_ATTEMPTS, retryAfterSeconds }, { "retry-after": String(retryAfterSeconds) });

// Casing cannot multiply a budget: SQLite matches `email = ?` case-sensitively, so folding here is
// strictly stricter than the lookup it guards.
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

async function bucketFor(secret: string, kind: "ip" | "email", value: string, window: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`auth-budget:${kind}:${value}`)));
  return `${[...sig.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}:${window}`;
}

async function charge(db: D1Database, bucket: string, window: number, cost: number): Promise<number> {
  const row = await db
    .prepare("INSERT INTO auth_attempt_budget (bucket, window_start, n) VALUES (?1, ?2, ?3) ON CONFLICT(bucket) DO UPDATE SET n = n + ?3 RETURNING n")
    .bind(bucket, window, cost)
    .first<{ n: number }>();
  return row?.n ?? cost;
}

/**
 * Charges `cost` against this address, this email and the whole window, and says whether the attempt may
 * proceed. Call it BEFORE looking the account up: refusing on the bucket is what keeps the refusal from
 * depending on whether the address exists.
 */
export async function spendAuthBudget(
  db: D1Database,
  env: AuthBudgetEnv,
  { ip, email, cost, now = new Date() }: { ip: string | null; email: string; cost: number; now?: Date },
): Promise<AuthBudgetVerdict> {
  const window = Math.floor(now.getTime() / WINDOW_MS);
  const retryAfterSeconds = Math.ceil(((window + 1) * WINDOW_MS - now.getTime()) / 1000);
  try {
    // All three are charged before any of them is judged, so a refused attempt still counts everywhere.
    const mine = await charge(db, await bucketFor(env.SESSION_SECRET, "ip", ip ?? "", window), window, cost);
    const theirs = await charge(db, await bucketFor(env.SESSION_SECRET, "email", normalizeEmail(email), window), window, cost);
    const all = await charge(db, `*:${window}`, window, cost);
    if (Math.random() * PRUNE_ODDS < 1) {
      await db.prepare("DELETE FROM auth_attempt_budget WHERE window_start < ?1").bind(window - 1).run();
    }
    if (mine > (ip ? PER_IP : NO_IP)) return { allowed: false, reason: "per_ip", retryAfterSeconds };
    if (theirs > PER_EMAIL) return { allowed: false, reason: "per_email", retryAfterSeconds };
    if (all > GLOBAL) return { allowed: false, reason: "global", retryAfterSeconds };
    return { allowed: true };
  } catch (e) {
    // Fails open, for the reason in the header. This log line is the only signal that the cap is not in
    // force, so it is an error rather than a warning.
    console.error("auth budget unavailable", (e as Error).message);
    return { allowed: true };
  }
}

/**
 * Forgives the sign-in that turned out to be the real person's. There is no `cost` parameter on purpose:
 * what is forgiven is always one whole sign-in, and a caller free to refund half of one is a caller free
 * to reintroduce the charge-on-success this module exists to avoid.
 */
export async function forgiveAuthAttempt(
  db: D1Database,
  env: AuthBudgetEnv,
  { ip, email, now = new Date() }: { ip: string | null; email: string; now?: Date },
): Promise<void> {
  const window = Math.floor(now.getTime() / WINDOW_MS);
  try {
    const emailBucket = await bucketFor(env.SESSION_SECRET, "email", normalizeEmail(email), window);
    await db.prepare("DELETE FROM auth_attempt_budget WHERE bucket = ?1").bind(emailBucket).run();
    const ipBucket = await bucketFor(env.SESSION_SECRET, "ip", ip ?? "", window);
    // MAX(0, …) rather than a bare subtraction: the refund is a second statement, so a retry or a
    // concurrent prune must not be able to drive a counter negative and hand out free attempts.
    const refund = db.prepare("UPDATE auth_attempt_budget SET n = MAX(0, n - ?2) WHERE bucket = ?1");
    await refund.bind(ipBucket, COST_SIGNIN).run();
    // The global bucket is refunded too. It is the service-wide circuit breaker, so leaving success
    // charged there caps EVERY account at GLOBAL correct sign-ins per window — the same defect as the
    // address bucket's, one blast radius wider.
    await refund.bind(`*:${window}`, COST_SIGNIN).run();
  } catch (e) {
    // A forgiveness that did not happen only leaves the successful attempt counted, so it cannot lock
    // anyone out on its own — and failing the sign-in over it would be the lockout this module avoids.
    console.error("auth budget forgive failed", (e as Error).message);
  }
}

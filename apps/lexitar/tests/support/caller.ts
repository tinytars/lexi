/**
 * A distinct caller address per request, for suites that drive `/api/auth/password/*`.
 *
 * Every deployed request carries one — Cloudflare always sets `cf-connecting-ip` — so a test that sends
 * none is exercising a caller shape the platform does not produce, and lands in the anonymous bucket
 * `functions/_lib/auth-budget.ts` holds to the strictest cap. Sharing that bucket would couple unrelated
 * tests through a counter: adding a sign-in to one test would throttle the next. The caps themselves are
 * pinned in `tests/unit/auth-budget.test.ts`, which is where they belong.
 */
let n = 0;
export const callerHeaders = (): Record<string, string> => ({ "cf-connecting-ip": `198.51.100.${(n++ % 250) + 1}` });

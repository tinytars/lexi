// Forward-looking dates — the complement to time-ago.ts, which is past-only by construction: its
// first branch answers "just now" for anything in the future, so every future timestamp degrades to
// the same string. Pure, same contract as its sibling: the caller passes `now` (ms).

const DAY_MS = 86_400_000;

/** Whole days from `now` to `iso`, to the nearest day. Negative once the date has passed. */
export function daysUntil(iso: string, now: number): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return NaN;
  return Math.round((then - now) / DAY_MS);
}

/** "19 Nov" — with the year added only when it is not the year `now` falls in, where it is news. */
export function shortDate(iso: string, now: number, locale?: string): string {
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return "unknown";
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "in 5 days" / "tomorrow" / "in 3 hours". A date already past says so rather than counting down. */
export function timeUntil(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const sec = Math.round((then - now) / 1000);
  if (sec <= 0) return "already passed";
  const min = Math.round(sec / 60);
  if (min < 60) return min <= 1 ? "in less than a minute" : `in ${min} minutes`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr} hour${hr === 1 ? "" : "s"}`;
  const day = Math.round(hr / 24);
  if (day === 1) return "tomorrow";
  if (day < 30) return `in ${day} days`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `in ${mon} month${mon === 1 ? "" : "s"}`;
  const yr = Math.round(mon / 12);
  return `in ${yr} year${yr === 1 ? "" : "s"}`;
}

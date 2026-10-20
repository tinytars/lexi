import type { D1Database } from "../../functions/_lib/identity-types";

// Answers only the two lookups every session-gated route makes (revocation, namespace owner), so
// route tests can stay about their own subject. Anything broader belongs against a real D1
// (`useD1`); the ownership matrix is settled there in raw-authorization.test.ts.
export function fakeSessionDb(): D1Database & {
  revoke(accountId: string, at?: Date): void;
  own(r2KeyOrPrefix: string, accountId: string): void;
} {
  const revoked = new Map<string, string>();
  const owned = new Map<string, string>();

  // The ownership query binds a prefix match as the half-open range functions/_lib/key-range.ts
  // derives — `from`, then `from` with its final character advanced — and a flat key as itself. A
  // pair is recognised by that shape rather than by its position, so this does not encode the
  // query's bind order and does not accept the accidental pair one range's end makes with the next
  // one's start. It was `LIKE 'prefix%'` until the pattern outgrew what D1 accepts.
  const isRangeOf = (from: string, to: string): boolean =>
    to.length === from.length &&
    to.slice(0, -1) === from.slice(0, -1) &&
    to.charCodeAt(to.length - 1) === from.charCodeAt(from.length - 1) + 1;

  const matchOwner = (args: unknown[]): string | null => {
    const vals = args.map(String);
    const covers = (key: string): boolean => {
      for (let i = 0; i < vals.length; i++) {
        if (i + 1 < vals.length && isRangeOf(vals[i], vals[i + 1])) {
          if (key >= vals[i] && key < vals[i + 1]) return true;
          i++;
        } else if (key === vals[i]) return true;
      }
      return false;
    };
    for (const [key, accountId] of owned) if (covers(key)) return accountId;
    return null;
  };

  const db = {
    prepare(query: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...values: unknown[]) {
          stmt.args = values;
          return stmt;
        },
        async first<T>() {
          if (/sessions_valid_from FROM accounts/.test(query)) {
            return { sessions_valid_from: revoked.get(String(stmt.args[0])) ?? null } as T;
          }
          if (/FROM raw_objects/.test(query)) {
            const account_id = matchOwner(stmt.args);
            return (account_id ? { account_id } : null) as T;
          }
          throw new Error(`fakeSessionDb only answers the session and raw_objects lookups, got: ${query}`);
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return {};
        },
      };
      return stmt;
    },
    async batch() {
      return [];
    },
    revoke(accountId: string, at: Date = new Date()) {
      revoked.set(accountId, new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString());
    },
    own(r2Key: string, accountId: string) {
      owned.set(r2Key, accountId);
    },
  };
  return db as unknown as D1Database & {
    revoke(accountId: string, at?: Date): void;
    own(r2KeyOrPrefix: string, accountId: string): void;
  };
}

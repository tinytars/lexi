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

  const matchOwner = (patterns: unknown[]): string | null => {
    for (const [key, accountId] of owned) {
      for (const p of patterns) {
        const s = String(p);
        if (s.endsWith("%") ? key.startsWith(s.slice(0, -1)) : key === s) return accountId;
      }
    }
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

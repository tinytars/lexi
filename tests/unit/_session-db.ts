import type { D1Database } from "../../functions/_lib/identity-types";

/**
 * The smallest D1 a session-gated route needs.
 *
 * W71 made `requireSession` read `accounts.sessions_valid_from` on every authenticated request, so a
 * route test now needs a DB binding whether or not revocation is its subject. W73 added a second such
 * query: the raw/text/chat routes resolve who owns a client namespace before touching R2.
 *
 * It answers those two and nothing else — deliberately. A fake broad enough to stand in for the schema
 * would start being trusted for things only the real thing can settle, which is what the Miniflare
 * harnesses (`identity.test.ts`, `raw-authorization.test.ts`) are for. In particular the OWNERSHIP
 * MATRIX — owner vs provider vs stranger, live vs revoked link — is settled against a real D1 in
 * `raw-authorization.test.ts`; what this fake gives the route tests is only "someone owns it", so they
 * can go on being about content types and etags.
 *
 * Accounts are un-revoked and present unless `revoke()` says otherwise, which is the state every real
 * account is in. Namespaces are UNOWNED unless `own()` says otherwise, which is the state every
 * pre-migration-0008 object is in.
 */
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

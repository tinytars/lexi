import { normalizeClientId } from "../../src/lib/client-id";

// Kept free of D1/vault imports so the operator scripts can use it without type-checking the vault adapters.

/** The inverse of raw-owner.ts's namespacePrefixes: which client namespace an object key belongs to, or null if none. */
export function clientIdOfObjectKey(key: string): string | null {
  const m = /^[^/]+\/(?:(?:raw|text)\/([^/]+)\/.+|chat-(.+)\.enc)$/.exec(key);
  return m ? normalizeClientId(m[1] ?? m[2]) : null;
}

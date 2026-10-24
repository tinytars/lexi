import { normalizeClientId } from "../../src/lib/client-id";

// Kept free of D1/vault imports so the operator scripts can use it without type-checking the vault adapters.

/** The directories raw-owner.ts's namespacePrefixes CLAIMS, alongside the flat `chat-{id}.enc` key. */
const OWNED_DIRS = ["raw", "text", "regen-log"];

/**
 * The directories erasure.ts counts inside a subject's namespaces (NAMESPACED_PREFIXES) — the owned
 * set plus `orphaned-chat/`, which the W71 escape hatch writes and raw-owner.ts deliberately lets
 * NOBODY claim. So an object can sit inside a patient's namespace for the purpose of erasing them
 * while belonging to no claimable namespace at all, and the two questions need separate answers.
 */
const ERASED_DIRS = [...OWNED_DIRS, "orphaned-chat"];

/** One pattern, built per prefix set in one place: three copies of this regex had already drifted. */
const parser = (dirs: string[]) => {
  const re = new RegExp(`^[^/]+/(?:(?:${dirs.join("|")})/([^/]+)/.+|chat-(.+)\\.enc)$`);
  return (key: string): string | null => {
    const m = re.exec(key);
    return m ? normalizeClientId(m[1] ?? m[2]) : null;
  };
};

/** The inverse of raw-owner.ts's namespacePrefixes: which client namespace owns an object key, or null if none. */
export const clientIdOfObjectKey = parser(OWNED_DIRS);

/** Which namespace an ERASURE counts an object key under: the above, plus `orphaned-chat/{id}/`. */
export const erasedClientIdOfObjectKey = parser(ERASED_DIRS);

import type { Attachment } from "./attachment-types";

// Keys are content-addressed (sha8-filename), so the same file attached twice yields the same key —
// and a keyed {#each} over a list holding it twice throws each_key_duplicate. First occurrence wins.
export function uniqueByKey<T extends Pick<Attachment, "key">>(attachments: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const a of attachments) if (!byKey.has(a.key)) byKey.set(a.key, a);
  return [...byKey.values()];
}

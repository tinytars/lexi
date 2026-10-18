// A shared view-only text filter, extracted so every caller matches the exact same behavior:
// lowercase, split on whitespace, AND-of-tokens substring match. Never touches saved data.
export function filterTokens(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesTokens(hay: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const h = hay.toLowerCase();
  return tokens.every((t) => h.includes(t));
}

// Reduces a list to just one true index (a scoped search result), or passes it through
// untouched when `only` is undefined (the normal, unscoped render path).
export function onlyIndexed<T>(items: T[], only: number | undefined): T[] {
  if (only === undefined) return items;
  const item = items[only];
  return item === undefined ? [] : [item];
}

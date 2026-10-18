// Generic localStorage JSON persistence primitive. One place to get "load with a fallback, save
// silently no-op'ing outside the browser" right, instead of each caller hand-rolling its own pair.
export function loadJSON<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON<T>(key: string, value: T): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
}

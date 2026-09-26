// Runes are only available in a `.svelte.ts` module (the svelte plugin compiles those), so a plain
// `.test.ts` can neither open an effect scope nor own reactive state. This is the bridge for both.
export function effectRoot<T>(build: () => T): { value: T; stop: () => void } {
  let value!: T;
  const stop = $effect.root(() => void (value = build()));
  return { value, stop };
}

/** One reactive value a test can write, so an effect reading it actually re-runs. */
export function box<T>(initial: T): { current: T } {
  let current = $state(initial);
  return {
    get current() {
      return current;
    },
    set current(next: T) {
      current = next;
    },
  };
}

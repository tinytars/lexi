/**
 * Runs `fn` inside an `$effect.root`, so a `.svelte.ts` factory that registers `$effect`s can be
 * exercised without mounting a component.
 *
 * Lives in a `.svelte.ts` file because `$effect.root` is a rune: only files the Svelte plugin
 * compiles may use one, and a `.test.ts` is not compiled.
 *
 * `value` is a GETTER rather than a captured field: the root's callback does not necessarily complete
 * before this returns, and reading it eagerly hands back `undefined`, which looks exactly like a
 * broken factory and is not.
 *
 * A test using this MUST carry `// @vitest-environment jsdom` — see vitest.config.ts. Under the
 * default node environment the effects silently never run and every assertion about them passes.
 */
export function withEffectRoot<T>(fn: () => T): { readonly value: T; destroy: () => void } {
  const holder = {} as { value: T };
  const destroy = $effect.root(() => {
    holder.value = fn();
  });
  return {
    get value() {
      return holder.value;
    },
    destroy,
  };
}

/**
 * A reactive cell, for standing in as the prop a rune factory reads.
 *
 * A factory like createDraftSync takes a `getClient()` accessor and re-runs its `$effect` when what
 * that accessor reads CHANGES REACTIVELY. Backing it with a plain `let` in the test means the effect
 * subscribes to nothing and never fires again — which reads as "the factory is broken" and is really
 * "the test never told it anything happened". In the app the accessor closes over `$props`/`$derived`,
 * so this is the faithful stand-in, and it has to live here because `$state` is a rune.
 */
export function box<T>(initial: T): { value: T } {
  let v = $state(initial);
  return {
    get value() {
      return v;
    },
    set value(next: T) {
      v = next;
    },
  };
}

/**
 * Runs `sink` with `read()`'s value now and on every change, inside its own effect root.
 *
 * For asserting that a rune module is genuinely REACTIVE rather than merely correct when polled — a
 * getter that returns the right value but does not notify makes the UI render a stale state, which is
 * the failure mode worth catching for a lock screen. Returns the root's destroy.
 */
export function observe<T>(read: () => T, sink: (value: T) => void): () => void {
  return $effect.root(() => {
    $effect(() => sink(read()));
  });
}

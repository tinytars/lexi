# Linting

`npm run lint` — oxlint, wired into the `hosted` CI job.

**oxlint rather than ESLint**, chosen 2026-08-24 when the repo had no linter at all. A single binary
with no plugin dependency tree matters for a public repo, and it is fast enough not to lengthen CI. The tradeoff is real and worth stating: oxlint has **no
type-aware rules**, so `no-floating-promises` and `no-misused-promises` — genuinely valuable in a
codebase this asynchronous — are not covered. `npm run check` (svelte-check + tsc) remains the only
type-level gate. Adding typescript-eslint later for those two rules specifically is a reasonable
follow-up; adopting it wholesale is not, on dependency-tree grounds.

## Two rules are off, and not for convenience

**`unicorn/no-useless-spread`** — its autofix is unsound on typed arrays and it produced a real bug
here. In `functions/_lib/decoy-salt.ts`:

```ts
[...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")
```

The spread converts a `Uint8Array` to `number[]` so `.map()` may return strings. Remove it and
`Uint8Array.prototype.map` coerces each string back to a number, silently producing a different salt.
`npm run check` caught it, which is the system working — but a rule whose fix must be undone by the
typechecker is not earning its place.

**`unicorn/no-new-array`** — `mapPool` in `scripts/vault-sync.ts` pre-sizes a result array
(`new Array<R>(items.length)`) precisely so results can be written back by index and input order is
preserved. The rule warns that `new Array(n)` is ambiguous between length and single-element; with an
explicit generic and a length argument it is not, and `Array.from({ length })` would allocate and fill
for no reason.

**`eslint/no-unassigned-vars`** — fires on every `bind:this` target in a `.svelte` file, because
oxlint parses the script block and not the template that does the assigning. Nine false positives,
zero true ones.

## Adding a rule

Land it green. A rule introduced with a backlog of violations gets disabled within a week; fix the
findings in the same commit, or in preparatory commits before it is switched on.

## Findings fixed on adoption

Thirty-five in source, forty-nine in tests, all fixed rather than suppressed — the ratchet starts at
zero, with `--deny-warnings`, so the next one fails CI.

Forty of the test findings were dead `readFileSync`/`fileURLToPath` imports left behind by an earlier
`_migrate.ts` consolidation: real debt, invisible until something looked. Two were genuine defects
rather than tidiness:

- `tests/e2e/chat-from-leaf.spec.ts` matched `/[🔗✓]+/` without the `u` flag. 🔗 is a surrogate pair,
  so the character class was matching lone surrogates rather than the emoji.
- `functions/_lib/decoy-salt.ts` was *broken* by an autofix (see above) and caught by `npm run check`.

// Whether the configured AI provider is refusing calls for lack of credit, and whether the two
// UNPROMPTED background callers may try again.
//
// 402 is the one model failure that retrying cannot fix: the account is out of credit, so every
// further call is refused until a human tops it up. The corpus warmer and the leaf-regen sweep were
// both written to own their failures silently — correct for a busy model or a transient 502, wrong
// here, because the next thing the patient asks will fail outright and nothing on screen said so.
// So this latch does two things at once: it renders a badge, and it stops the loops.
//
// A module singleton rather than the createX(deps) factory used elsewhere, because the observer is
// installed from main.ts (into the fetch seam) before App.svelte mounts, and the two gated callers
// live in different modules — the same reason speech-registry.svelte.ts is one.

/**
 * The routes whose success clears the latch: the ones where a 2xx cannot mean anything BUT a model
 * call that was paid for. Deliberately not /api/corpus-warm, even though the latch halts it —
 * functions/api/corpus-warm.ts answers 200 for `off`, `unsupported` and `no_corpus` without going
 * near the provider, so its success proves nothing and would lower the latch on an empty account.
 */
const PROBE_ROUTES = new Set(["/api/leaf-regen", "/api/chat"]);

export interface AiAvailability {
  /** A model call was refused for lack of credit and no background probe has succeeded since. */
  readonly outOfCredit: boolean;
  /**
   * Whether an unprompted background call may fire now, consuming the single probe slot if it does.
   * Always true when nothing is wrong, so the normal path pays nothing for this.
   */
  mayProbe(): boolean;
  /** A presence signal — the tab came back, a record was opened — grants one probe. */
  rearm(): void;
  /** Every same-origin /api response, from the fetch seam in error-reporter.ts. */
  observe(pathname: string, status: number): void;
}

function createAiAvailability(): AiAvailability {
  let outOfCredit = $state(false);
  // Not $state: this coordinates requests and must never drive rendering.
  let probe = false;

  return {
    get outOfCredit() {
      return outOfCredit;
    },

    mayProbe() {
      if (!outOfCredit) return true;
      if (!probe) return false;
      probe = false;
      return true;
    },

    rearm() {
      if (outOfCredit) probe = true;
    },

    observe(pathname, status) {
      // Only classifyModelError() answers 402 in this app (functions/_lib/model-errors.ts), so the
      // status alone identifies the cause and no route table is needed to read it.
      if (status === 402) {
        outOfCredit = true;
        probe = false;
        return;
      }
      if (outOfCredit && status >= 200 && status < 300 && PROBE_ROUTES.has(pathname)) {
        outOfCredit = false;
        probe = false;
      }
    },
  };
}

export const aiAvailability = createAiAvailability();

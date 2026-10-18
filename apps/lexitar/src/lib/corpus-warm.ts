// Keeps the patient's reports warm in the prompt cache for as long as it is cheaper than letting
// them go cold — and not one cycle longer. See CORPUS.md's caching section.

import { createCorpusLane, type CorpusLane } from "./corpus-lane";

/**
 * Just under the 5-minute entry lifetime. A read restarts that clock for free, so a request landing
 * inside the window keeps the entry alive indefinitely; one landing outside it pays a full write.
 */
export const KEEPALIVE_INTERVAL_MS = 4.5 * 60 * 1000;

/**
 * How many times an UNUSED entry is worth refreshing, derived rather than chosen: a cache write
 * costs 1.25x base input and a read 0.1x, so twelve refreshes (1.2x) still come in under one write.
 * The thirteenth is the point where holding a record nobody is asking about costs more than
 * re-reading it when they finally do — so the warmer stops there rather than billing a patient's
 * open tab for the rest of the afternoon.
 */
export const MAX_IDLE_KEEPALIVES = 12;

export interface CorpusWarmer {
  /** A record was selected (or re-selected): warm it now and start the budget over. */
  select(clientId: string | null): void;
  /** The tab came back to the foreground — presence, so the budget starts over. */
  wake(): void;
  stop(): void;
}

/**
 * `warm` owns its own failures. A cold cache is a slower answer, never a wrong one, so nothing here
 * is worth surfacing to a patient — and a warm that throws must not kill the timer with it.
 *
 * There is deliberately no "the patient just asked something" signal threaded in from ChatTab: a
 * real chat turn is itself a cache read, so it refreshes the entry on its own, and the only thing
 * the extra wiring would buy is resetting the idle budget during a conversation long enough to
 * exhaust it — an hour of it — which its own turns are already keeping alive.
 */
export function createCorpusWarmer(warm: (clientId: string) => Promise<unknown>, lane: CorpusLane = createCorpusLane()): CorpusWarmer {
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshes = 0;

  const fire = (): void => {
    if (current === null) return;
    const id = current;
    // W86 — queued behind whatever corpus-sized request the leaf sweep already has in the isolate,
    // and re-checked when its turn comes: warming a record the patient has since moved off would be
    // a cache write nobody reads. Only the SELECT edge fires immediately-ish; the keepalive timer is
    // 4.5 minutes apart and never contends with anything.
    void lane.run(() => (current === id ? warm(id) : Promise.resolve())).catch(() => {});
  };

  const schedule = (): void => {
    clearTimeout(timer);
    if (current === null || refreshes >= MAX_IDLE_KEEPALIVES) return;
    timer = setTimeout(() => {
      refreshes += 1;
      fire();
      schedule();
    }, KEEPALIVE_INTERVAL_MS);
  };

  const restart = (): void => {
    refreshes = 0;
    fire();
    schedule();
  };

  return {
    select(clientId) {
      current = clientId;
      if (clientId === null) {
        clearTimeout(timer);
        return;
      }
      restart();
    },
    wake() {
      if (current !== null) restart();
    },
    stop() {
      clearTimeout(timer);
      current = null;
    },
  };
}

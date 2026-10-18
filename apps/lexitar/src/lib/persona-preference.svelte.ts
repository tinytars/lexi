// Who answers, as an account preference: the value the sidebar picker shows and chat speaks in.
//
// Extracted from App.svelte to fix a race it could not be tested for. Every login path re-reads the
// account, and the record's sidebar is already interactive while that read is in flight — so a pick
// made in that window was overwritten by the load's answer, which was fetched BEFORE the pick. The
// preference reached the server (the PUT went out) and came back on the next load, but the picker
// snapped back to Lexi in front of the person who had just chosen Cody.

import { DEFAULT_PERSONA, type PersonaId } from "./personas";

export interface PersonaPreferenceDeps {
  /** The account's stored persona. Never throws — an unreadable preference is the default. */
  load: () => Promise<PersonaId>;
  save: (persona: PersonaId) => Promise<void>;
  reportError: (message: string) => void;
}

export interface PersonaPreference {
  readonly current: PersonaId;
  /** Apply the stored preference, unless the person has chosen one since this load began. */
  hydrate: () => Promise<void>;
  /** The picker's click: shown immediately, written to the account behind it. */
  choose: (next: PersonaId) => Promise<void>;
}

export function createPersonaPreference(deps: PersonaPreferenceDeps): PersonaPreference {
  let current = $state<PersonaId>(DEFAULT_PERSONA);
  // Counting picks rather than comparing values: two loads can be in flight at once (a login path and
  // the post-email-verify refresh), and a pick back to what was stored is still a pick to be kept.
  let picks = 0;

  return {
    get current() {
      return current;
    },

    async hydrate() {
      const asOf = picks;
      const loaded = await deps.load();
      if (picks === asOf) current = loaded;
    },

    async choose(next: PersonaId) {
      picks++;
      current = next;
      try {
        await deps.save(next);
      } catch (e) {
        // The picker keeps showing the choice: the next load is what corrects it, and silently
        // reverting under the cursor is how this bug read in the first place.
        deps.reportError((e as Error).message);
      }
    },
  };
}

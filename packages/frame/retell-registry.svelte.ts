// An app may offer a second telling of any assistant bubble (e.g. the same content in another voice).
// PersonaBubble adds a menu item for it while one is configured; this package knows nothing of what
// the retelling says, only its label and the voice it is read aloud in.
export interface Retell {
  label: string;
  voice?: string;
  retell(text: string): Promise<string | null>;
}

const state = $state<{ current: Retell | null }>({ current: null });

export function configureRetell(r: Retell | null): void {
  state.current = r;
}

export function currentRetell(): Retell | null {
  return state.current;
}

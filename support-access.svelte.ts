// The support console: which lists a support agent sees, what they have asked for, and whose record
// they are about to open.
//
// W76 — App.svelte's third controller extraction. The server side of support access is well covered
// (support-access-function.test.ts, support-provider-roster-function.test.ts, and W75's
// auth-client-support.test.ts); what had no test is the browser's answer to "which session is this
// person in, and whose roster are they looking at" — a six-field state machine that decides whether
// a patient's name is even offered.
//
// Same getter-parameterized factory shape as vault-principals.svelte.ts and
// recovery-controller.svelte.ts. The audited drill-in stops at the envelope: unwrapping it, decrypting
// the vault and moving the app to that patient is App's, because App owns the vault, the DEK and the
// navigation. What is here is the part that decides WHETHER to ask for the envelope at all.

import type { VaultSession, VaultEntry } from "./vault-session.svelte";
import {
  listSupportPatients,
  listSupportProviders,
  listSupportRequests,
  requestSupportAccess,
  cancelSupportRequest,
  getProviderRoster,
  enterSupportPatient,
  type SupportPatient,
  type SupportProvider,
  type SupportRosterPatient,
  type SupportRequest,
} from "../security/auth-support";

/** What the audited /api/support/access hands back — the envelope plus who it belongs to. */
export interface SupportEntry extends VaultEntry {
  vaultId: string;
}

export interface SupportProviderView {
  providerAccountId: string;
  displayName: string;
  roster: SupportRosterPatient[];
}

export interface SupportAccessDeps {
  /** `providerKey` unwraps the envelope; without it there is nothing to drill into. */
  session: VaultSession;
  /**
   * App's shared error line, not a panel of this console's own. Preserved from the extraction: the
   * support console IS the whole screen in this session, so its errors have always been the shell's.
   */
  reportError: (message: string | null) => void;
  /**
   * Unwrap, decrypt, and move the app to this patient. App owns all three. The provider key is passed
   * rather than re-read: it was checked here, and handing it over is what makes that check load-bearing
   * instead of leaving the host to assert a non-null it cannot prove.
   */
  openPatientVault: (entry: VaultEntry, providerKey: CryptoKey) => Promise<void>;
}

export interface SupportAccess {
  /** Whether this account is a support agent, and so gets the console instead of the roster. */
  readonly isSupportSession: boolean;
  readonly patients: SupportPatient[];
  readonly providers: SupportProvider[];
  /** Outstanding (invited) requests, so an ask is visibly pending rather than silently nothing. */
  readonly requests: SupportRequest[];
  /** The clinician roster currently drilled into, or null at the console top level. */
  readonly providerView: SupportProviderView | null;
  /** Bound to the request-access input. */
  requestEmail: string;

  /** Enter the support console and load everything it shows. */
  beginSession(): Promise<void>;
  loadPatients(): Promise<void>;
  loadProviders(): Promise<void>;
  loadRequests(): Promise<void>;
  /** Ask a patient for access by email. */
  requestAccess(): Promise<void>;
  cancelRequest(linkId: string): Promise<void>;
  openProvider(p: SupportProvider): Promise<void>;
  closeProvider(): void;
  /** The audited drill-in. Hands the envelope to the host and never touches it here. */
  enterPatient(patientAccountId: string): Promise<void>;
  /** Clears the console on sign-out. */
  reset(): void;
}

export function createSupportAccess(deps: SupportAccessDeps): SupportAccess {
  let isSupportSession = $state(false);
  let patients = $state<SupportPatient[]>([]);
  let providers = $state<SupportProvider[]>([]);
  let requests = $state<SupportRequest[]>([]);
  let providerView = $state<SupportProviderView | null>(null);
  let requestEmail = $state("");

  /** Every list load reports to the same line and none of them is worth aborting the console over. */
  async function load(body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (e) {
      deps.reportError((e as Error).message);
    }
  }

  /**
   * Re-reads the drilled-into roster if one is open. A request or a cancellation changes the `pending`
   * and `openable` flags on the very rows being looked at, and without this the row keeps offering the
   * button that was just pressed.
   */
  async function refreshProviderView(): Promise<void> {
    if (!providerView) return;
    providerView = { ...providerView, roster: await getProviderRoster(providerView.providerAccountId) };
  }

  async function loadPatients() {
    await load(async () => {
      patients = await listSupportPatients();
    });
  }

  async function loadProviders() {
    await load(async () => {
      providers = await listSupportProviders();
    });
  }

  async function loadRequests() {
    await load(async () => {
      requests = await listSupportRequests();
    });
  }

  return {
    get isSupportSession() {
      return isSupportSession;
    },
    get patients() {
      return patients;
    },
    get providers() {
      return providers;
    },
    get requests() {
      return requests;
    },
    get providerView() {
      return providerView;
    },
    get requestEmail() {
      return requestEmail;
    },
    set requestEmail(v: string) {
      requestEmail = v;
    },

    async beginSession() {
      isSupportSession = true;
      await loadPatients();
      await loadProviders();
      await loadRequests();
    },

    loadPatients,
    loadProviders,
    loadRequests,

    async requestAccess() {
      const em = requestEmail.trim();
      if (!em) return;
      deps.reportError(null);
      try {
        await requestSupportAccess(em);
        requestEmail = "";
        // Invited until approved — show it as pending, and refresh the active lists too.
        await loadRequests();
        await loadPatients();
        await loadProviders();
        await refreshProviderView();
      } catch (e) {
        deps.reportError((e as Error).message);
      }
    },

    async cancelRequest(linkId: string) {
      deps.reportError(null);
      try {
        await cancelSupportRequest(linkId);
        await loadRequests();
        await refreshProviderView();
      } catch (e) {
        deps.reportError((e as Error).message);
      }
    },

    async openProvider(p: SupportProvider) {
      deps.reportError(null);
      try {
        providerView = { providerAccountId: p.providerAccountId, displayName: p.displayName, roster: await getProviderRoster(p.providerAccountId) };
      } catch (e) {
        deps.reportError((e as Error).message);
      }
    },

    closeProvider() {
      providerView = null;
    },

    async enterPatient(patientAccountId: string) {
      const providerKey = deps.session.providerKey;
      if (!providerKey) return;
      deps.reportError(null);
      try {
        await deps.openPatientVault(await enterSupportPatient(patientAccountId), providerKey);
      } catch (e) {
        deps.reportError((e as Error).message);
      }
    },

    reset() {
      // W76 — all six, where App used to clear two. The drill-in view was the one that mattered:
      // nothing reloads it on the next sign-in the way the three lists are reloaded, so a support
      // agent signing out and another signing in on the same browser opened onto the previous
      // agent's clinician roster.
      isSupportSession = false;
      patients = [];
      providers = [];
      requests = [];
      providerView = null;
      requestEmail = "";
    },
  };
}

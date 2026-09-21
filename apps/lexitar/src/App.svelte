<script lang="ts">
  import { decryptVaultV2, unwrapDEKWithPrivateKey } from "@tinytars/vault/crypto";
  import { ALL_GROUP_KEY } from "./lib/sidebar-labels";
  import type { Vault, Client, NoteAttachment } from "./lib/types";
  import type { UnitSystem } from "./lib/units";
  import { DEFAULT_PERSONA, PERSONAS, type PersonaId } from "./lib/personas";
  import { loadPersona, savePersona, personaTake } from "./lib/persona-client";
  import { configureRetell } from "@tinytars/frame/retell-registry.svelte";
  import { saveVaultV2, vaultSink, rememberVaultEtag, VaultConflictError, setVaultConflictHandler } from "@tinytars/vault/vault-sink";
  import { getMyAccount, loginPassword, loginPasskey, signupPassword, signupPasskey, bootstrapGoogleSession } from "@tinytars/vault/auth-client";
  import { updateProfile, getVaultPrincipals, getAccessEvents, type AccessEventRow } from "@tinytars/vault/auth-recovery";
  import { putAccountKey, getAccountKey, clearAccountKey } from "@tinytars/vault/key-store";
  import { isFindingStale, staleNodes } from "./lib/staleness";
  import { nodeInputCanonical } from "./lib/node-input-hash";
  import { applyLeafRegen } from "./lib/leaf-regen-client";
  import { createLeafRegenQueue, UNOWNED_LEAF_NODES } from "./lib/leaf-regen-queue.svelte";
  import { createVaultSave } from "./lib/vault-save.svelte";
  import { createVaultSession, openVault, type VaultEntry } from "@tinytars/frame/vault-session.svelte";
  import { createVaultPrincipals } from "@tinytars/frame/vault-principals.svelte";
  import { createRecoveryController } from "@tinytars/frame/recovery-controller.svelte";
  import { createSupportAccess } from "@tinytars/frame/support-access.svelte";
  import { createAccountMethods, type RemovableMethod } from "@tinytars/frame/account-methods.svelte";
  import { createRosterSession, RESUME_MARKER, type RosterPatient } from "@tinytars/frame/roster-session.svelte";
  import { ensureOrgRecoveryEnvelope } from "@tinytars/vault/org-recovery";
  import { fetchPersonalizedRange } from "./lib/ranges-client";
  import { b64ToBytes } from "@tinytars/vault/base64";
  import { describeAiError } from "./lib/ai-error";
  import { dagNode } from "./lib/finding-dag";
  import { tick } from "svelte";
  import { TABS, DEFAULT_TAB, type Tab } from "./lib/nav";
  import { bootFromLocation } from "./lib/boot-location";
  import { parseHash, toHash, SECTION_TAB, type Permalink } from "./lib/permalink";
  import { flashAnchor, reportAnchor } from "./lib/anchor";
  import { normalizeClientId, vaultIdFromR2Key } from "./lib/client-id";
  import { ensureLeafIds } from "./lib/leaf-ids";
  import Sidebar from "./lib/Sidebar.svelte";
  import ChatTab from "./lib/ChatTab.svelte";
  import { createChatThreadSession } from "./lib/chat-thread-session.svelte";
  import { createNavController } from "./lib/nav-controller";
  import { resolveDefaultGroup, GROUP_SECTIONS, FIRST_SYSTEM_DEFAULT_SECTIONS, decideHashSync, decideVisibilityBounce } from "./lib/nav-decisions";
  import { createConflictResolver } from "./lib/conflict-resolver";
  import { buildRefreshMessage } from "./lib/refresh-message";
  import { patientSwitchedMidRequest } from "./lib/stale-guard";
  import { eligibleMarkersForRangeFill } from "./lib/range-eligibility";
  import { decideSidebarAction } from "./lib/sidebar-dispatch";
  import ReportSections from "./lib/ReportSections.svelte";
  import { ALL_SECTIONS, presentSections } from "./lib/report-sections";
  import { buildSearchIndex } from "./lib/search-index";
  import { filterTokens, matchesTokens } from "@tinytars/frame/filter";
  import SearchPanel from "./lib/SearchPanel.svelte";
  import AboutOverlay from "./lib/AboutOverlay.svelte";
  import Modal from "@tinytars/frame/Modal.svelte";
  import Button from "@tinytars/frame/Button.svelte";
  import ExportTab, { type ExportOption } from "@tinytars/frame/ExportTab.svelte";
  import { exportCsv, exportJson } from "./lib/export";
  import ImportTab from "./lib/ImportTab.svelte";
  import { createAuthFlow } from "./lib/auth-flow";
  import { importFileForChat, type ChatImportResult } from "./lib/import-flow";
  import { withClient } from "./lib/vault-clients";
  import { reclaimOrphans } from "./lib/orphan-claim";
  import { putRaw } from "./lib/attachment-store";
  import { healRawPageCounts } from "./lib/raw-pages-heal";
  import { togglePinnedIn, renameIn, removeFrom, labelOf, type SidebarItemKind } from "./lib/vault-item-ops";
  import { pinnedQueries } from "@pablotech/akesi/pinned-queries";
  import Onboarding, { type OnboardingField } from "@tinytars/frame/Onboarding.svelte";
  import AccountMenu from "@tinytars/frame/AccountMenu.svelte";
  import SpeechControls from "@tinytars/frame/SpeechControls.svelte";
  import { speechRegistry, configureSpeech } from "@tinytars/frame/speech-registry.svelte";
  import { neuralSpeech } from "./lib/speech-engine";
  import LoginScreen from "@tinytars/frame/LoginScreen.svelte";
  import RecoveryCodeDialog from "./lib/RecoveryCodeDialog.svelte";
  import AttachPicker from "@tinytars/frame/AttachPicker.svelte";
  import FindingDag from "./lib/FindingDag.svelte";
  import VisibilitySettings from "@tinytars/frame/VisibilitySettings.svelte";
  import Diagnostics from "@tinytars/frame/Diagnostics.svelte";
  import DictateButton from "@tinytars/frame/DictateButton.svelte";
  import { canSee, FEATURES, patientCanSee } from "./lib/visibility";
  import { sidebarActionFor } from "./lib/sidebar-actions";
  import LeafActionMenu from "@tinytars/frame/LeafActionMenu.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { systemOrder } from "@pablotech/akesi/system-groups";
  import { refreshFindingWithLeaves, logRefreshEvent, fetchRefreshLog, type RefreshProgress } from "./lib/refresh-client";
  import type { RefreshStage } from "./lib/finding-refresh";
  import { refreshMarkerGroups } from "./lib/marker-groups-client";
  import { timeAgo } from "@tinytars/frame/time-ago";
  import { PRODUCT_NAME, FOUNDATION } from "./lib/brand";
  import OrgFooter from "@tinytars/frame/OrgFooter.svelte";
  import Disclaimer from "./lib/Disclaimer.svelte";
  import { runWithConcurrency } from "@tinytars/frame/concurrency";
  import { loadSidebarMode, modeForSection } from "./lib/sidebar-mode";
  import { loadLastSection, saveLastSection, loadLastGroup, saveLastGroup } from "./lib/nav-memory";
  import { loadJSON, saveJSON } from "@tinytars/frame/persisted-json";

  // W84 — read-aloud uses the personas' neural voices, the browser voice only as a fallback.
  configureSpeech(neuralSpeech);

  // W44 — one patient the signed-in provider can open (from /api/providers/patients); the
  // envelope carries this provider's wrapped DEK for that vault. Replaces the old fam4 roster.

  // W44 — account login. email/password (+ passkey) authenticate against /api/auth/*; the server
  // sets a signed hd_session cookie. The vault opens with the DEK unwrapped client-side at login.
  let email = $state("");
  let password = $state("");
  let signupMode = $state(false);
  // W73 — back on. W50 hid it, and combined with W48 (signup no longer mints a code) the result was
  // that a user could hold no recovery credential at all and never once be told. Minting stays
  // on-demand by owner decision; being told is the part that was missing. See RECOVERY.md I6.
  const SHOW_RECOVERY_NUDGE = true;
  let vault = $state<Vault | null>(null);
  let unlocking = $state(false);
  let error = $state<string | null>(null);
  let selectedClientId = $state<string | null>(null);
  // Read-aloud outlives the bubble it came from, but never the record: closing the vault or
  // switching patient stops it. Keyed on the boolean, since `vault` is reassigned on every save.
  const vaultOpen = $derived(vault !== null);
  $effect(() => {
    void vaultOpen;
    void selectedClientId;
    speechRegistry.stop();
  });
  // W72 — the unlocked-session key material lives in one object with one transition each way
  // (vault-session.svelte.ts). These were four separate $state declarations set and cleared in eight
  // separate assignments, so a half-open session — a live DEK for a vault the user had closed — was
  // representable. docs/cross-app/10 names this consolidation as its Phase A prerequisite.
  const session = createVaultSession();
  // W48 — the signed-in account's private key, owner OR provider; account-method ops (add passkey/
  // password/Google, generate recovery) use this so they work in provider sessions too.
  let acctPrivateKey = $derived(session.ownerKey ?? session.providerKey);
  // W15/3a — who is signed in and whose record is open: the provider flag (which persists through a
  // drill-in so provider-only surfaces stay available), the clinician roster, and the cold-load resume.
  // W76 — roster-session.svelte.ts.
  const roster = createRosterSession({
    session,
    reportError: (m) => (error = m),
    clearLoginForm: () => { email = ""; password = ""; },
    openOwnVault: (r2Key, dek) => openOwnVault(r2Key, dek),
    afterOwnerEnter: async (rotationPending) => {
      await ensureOrgRecoveryEnvelope(session);
      // W47 — load account info so the top-right account menu can show the email + verification state.
      try { await refreshAccount(); } catch { /* menu falls back to no email */ }
      // W44 P4c — a support grant expired while offline; complete the deferred DEK rotation now.
      if (rotationPending) { try { await vaultAccess.rotateVaultKey(); } catch (e) { error = (e as Error).message; } }
    },
    beginSupportSession: async () => {
      try { await refreshAccount(); } catch { /* menu falls back to no email */ }
      await support.beginSession();
    },
    beginClinicianSession: async () => {
      try { await refreshAccount(); } catch { /* menu falls back to no email */ }
      fetchProviderToken();
      // W50 — a clinician may have pending support-agent roster requests to approve.
      await vaultAccess.refreshQuietly();
    },
    openPatientVault: (entry, providerKey) => openPatientVault(entry, providerKey),
    closeVault: () => { vault = null; selectedClientId = null; },
    confirmRemoval: (label) => confirm(`Remove ${label} from your roster? You'll lose access unless they grant it again.`),
  });
  let visibilityOpen = $state(false);
  // W44 P4 — owner-side "who can see my record" panel: list/grant/revoke providers. Grant wraps the
  // in-memory DEK to the provider's public key client-side (zero-knowledge); the server only records
  // the opaque envelope + link.
  // W76 — the whole cluster (six $state, three $derived, seven handlers, and the vault re-key) now
  // lives in vault-principals.svelte.ts, where it can be tested. App keeps only what it owns: the
  // decrypted record and the sink that writes it.
  const vaultAccess = createVaultPrincipals({
    getVault: () => vault,
    session,
    saveVault: (v, id, dek) => saveVaultV2(v, id, dek, vaultSink),
    reportError: (m) => (error = m),
  });
  const recovery = createRecoveryController<RosterPatient>({
    session,
    getEmail: () => email,
    ensureExtractableKey: () => account.ensureExtractableKey(),
    refreshAccount,
    setAccountBusy: (b) => account.setBusy(b),
    reportAccountError: (m) => account.setError(m),
    setUnlocking: (b) => (unlocking = b),
    reportError: (m) => (error = m),
    enterRecovered: async (r) => {
      await roster.enterAccount(r);
      await roster.persistSessionKey(r.privateKey); // W49 — survive a refresh
    },
  });
  // W44 P4b — a support agent (provider_kind='support') gets a distinct console (request access by
  // email + a list of consented patients) instead of the clinician roster; entry is audited.
  const support = createSupportAccess({
    session,
    reportError: (m) => (error = m),
    openPatientVault: (entry, providerKey) => openPatientVault(entry, providerKey),
  });
  // W44 P8 — the owner Account settings modal: profile edit + login-method management.
  const account = createAccountMethods({
    getPrivateKey: () => acctPrivateKey,
    isProviderSession: () => roster.isProvider,
    applyUnitSystem: (u) => (unitSystem = u),
    // The recovery block and the access log are App's: they feed the recovery controller and the
    // events list, neither of which is about a login method.
    loadOwnerBlocks: async () => {
      const [principals, access] = await Promise.all([getVaultPrincipals(), getAccessEvents()]);
      recovery.applyPrincipals(principals);
      accessEvents = access.events;
    },
  });
  let accessEvents = $state<AccessEventRow[]>([]);
  // W45 — Google OAuth: a lock-screen error surfaced from the callback redirect (?google_error=…).
  let googleError = $state<string | null>(null);
  // W39/Phase 4 — provider-only refresh diagnostics (the persisted R2 audit trail). Gated like the
  // refresh button (roster.isProvider && providerToken); route-global, not per-patient.
  let diagnosticsOpen = $state(false);
  // W15/3b — the distinct provider token (from /api/provider-token) that authorizes the money-
  // spending Finding refresh; fetched on provider unlock, held in memory. Null → refresh unavailable.
  let providerToken = $state<string | null>(null);
  let refreshing = $state(false);
  let refreshStage = $state<RefreshStage | null>(null);
  let refreshError = $state<string | null>(null);
  // W70 — a save refused because the record moved under us. Held here rather than inside vaultSave
  // because SIX of the seven save paths bypass the queue; the sink's conflict hook reports them all.
  //
  // Nothing is resolved automatically, and that is the point. Auto-reloading discards this tab's whole
  // session (a write carries the entire vault, so "this tab's edits" means everything since unlock).
  // Auto-overwriting discards the other side's edits, which are already durable. Auto-merging needs a
  // schema this codebase does not have. So: freeze, and ask.
  let vaultConflict = $state<VaultConflictError | null>(null);
  let resolvingConflict = $state(false);
  setVaultConflictHandler((e) => (vaultConflict = e));

  const conflictResolver = createConflictResolver({
    getVault: () => vault,
    setVault: (v) => (vault = v),
    getDek: () => session.dek,
    getR2Id: () => session.r2Id,
    getConflict: () => vaultConflict,
    setConflict: (e) => (vaultConflict = e),
    getResolving: () => resolvingConflict,
    setResolving: (v) => (resolvingConflict = v),
    fetchVaultBlob,
    saveVault: (v, id, dek) => saveVaultV2(v, id, dek, vaultSink),
    decryptVault: async (blob, dek) => ensureLeafIds(await decryptVaultV2<Vault>(blob, dek)),
  });
  const resolveConflictKeepMine = conflictResolver.resolveConflictKeepMine;
  const resolveConflictTakeTheirs = conflictResolver.resolveConflictTakeTheirs;
  let refreshProgress = $state<RefreshProgress | null>(null);

  let windowYears = $state<number>(1);
  // M85 Phase 2 — the cross-menu search box's query and derived results. M105 — the query (never
  // the derived results, which stay live) is remembered across reload, shared by every role/client.
  const SEARCH_QUERY_KEY = "hd_last_search_query";
  let searchQuery = $state(loadJSON<string>(SEARCH_QUERY_KEY, ""));
  $effect(() => { saveJSON(SEARCH_QUERY_KEY, searchQuery); });
  // M91 Phase 2 — whether the search panel is showing, decoupled from query non-emptiness so an
  // empty-query "home" state is a real, distinct visual state (Google-homepage style). Opened by
  // the Sidebar's Search nav row; the panel itself now owns the query input.
  let searchOpen = $state(false);
  // M104 — bumped every time onOpenSearch/onFreshSearch fires so SearchPanel can force-focus its
  // input even when it isn't being freshly mounted (a re-click while already open). Reopening via
  // the Search row resumes the last query/results; the row's own "+" (onFreshSearch) is the
  // explicit fresh-start action that clears the query.
  let searchFocusToken = $state(0);
  let activeTab = $state<Tab>(DEFAULT_TAB);
  // W38 — the active subsection key below the tab, bound into ReportSections. The client/tab/section
  // triple is the persisted location (mirrored to the hash); the anchor is a one-shot scroll target,
  // never persisted (the grab button builds the full shareable link with anchor on demand).
  let section = $state<string | null>(null);
  // M70 — a leaf-card "Chat about this" action stashes its permalink here; the pendingSeed
  // resolution effect below resolves it into a seeded thread once loaded (Phase 2).
  let chatSeedRequest = $state<Permalink | null>(null);
  // M76 Phase 5 — chat thread state, lifted out of ChatTab.svelte so Sidebar.svelte's lower zone can
  // render/drive the thread list. `section` continues to double as the active thread id whenever
  // activeTab === "chat" (no new "current thread id" concept). W79 phase 3a — the state itself and
  // its hydration/persist/action logic moved into chat-thread-session.svelte.ts; App keeps only the
  // state this concern doesn't own (client, dek, vault, tab, section, seed request).
  const chatSession = createChatThreadSession({
    getSelectedClientId: () => selectedClientId,
    getDek: () => session.dek,
    getVault: () => vault,
    isChatTab: () => activeTab === "chat",
    getSection: () => section,
    setSection: (v) => { section = v; },
    getChatSeedRequest: () => chatSeedRequest,
    setChatSeedRequest: (v) => { chatSeedRequest = v; },
    confirmDelete: (message) => confirm(message),
  });
  // W79 phase 3a — applyNav/navigate's branching moved into nav-controller.ts; App keeps only the
  // state it reads/writes and the two functions (resolveAnchor, rememberSection) it calls into.
  const navController = createNavController({
    clientExists: (id) => !!vault?.clients[id],
    getSelectedClientId: () => selectedClientId,
    setSelectedClientId: (id) => { selectedClientId = id; },
    getActiveTab: () => activeTab,
    setActiveTab: (tab) => { activeTab = tab; },
    getSection: () => section,
    setSection: (s) => { section = s; },
    setActiveGroup: (g) => { activeGroup = g; },
    setActiveLeaf: (l) => { activeLeaf = l; },
    setPendingAnchor: (a) => { pendingAnchor = a; },
    setPendingSidebarAction: (a) => { pendingSidebarAction = a; },
    setSearchOpen: (open) => { searchOpen = open; },
    resolveAnchor,
    rememberSection,
  });
  const applyNav = navController.applyNav;
  const navigate = navController.navigate;
  // M75 — a sidebar row's "+" action stashes its target here; bound/passed into the leaf that mounts
  // at that tab/section, which auto-opens its own existing Add flow (see triggerSidebarAction below).
  let pendingSidebarAction = $state<{ section?: string; verb: "new" | "add" } | null>(null);
  // A deep-link captured at cold start, re-applied after the vault unlocks (so the link's client
  // wins over the vault's auto-selected one). Cleared once applied.
  let pendingNav: Permalink | null = null;

  // W67 — the chain, the flash timer and the two flags live in vault-save.svelte.ts. The write itself
  // stays here because the vault, its key and its R2 id are App's; what left is the queueing.
  const vaultSave = createVaultSave();

  // W70 — the app had ZERO live regions: `aria-live`, `role="alert"`, `role="status"` and `aria-busy`
  // returned no matches across App.svelte and all 62 lib components. Every error was a silently
  // inserted <p> and every "✓ saved" passed unannounced, so a screen-reader user who mistyped their
  // password on the login screen got no feedback at all.
  //
  // One pair of regions at the shell, not `role="alert"` sprinkled over the eight scattered <p>s —
  // that would be the same fact written in eight places, which is how they drift apart.

  const announcedError = $derived(
    vaultSave.error ?? error ?? vaultAccess.error ?? account.error ?? googleError ?? refreshError ?? recovery.issueError ?? "",
  );


  const today = new Date().toISOString().slice(0, 10);

  // W38 — hash permalink routing: the URL is #<client>/<tab>/<section>/<anchor>. On cold start
  // we seed the tab/section/anchor from the hash and stash the whole link to re-apply once the
  // vault unlocks (see unlock/enterPatient); live hashchange (back-button, pasted link) is applied
  // immediately. The four-part location is mirrored back to the hash on every in-app navigation.
  if (typeof window !== "undefined") {
    const boot = bootFromLocation(new URL(window.location.href), localStorage);
    if (boot.permalink) {
      activeTab = boot.permalink.tab;
      section = boot.permalink.section ?? null;
      pendingNav = boot.permalink;
    }
    window.addEventListener("hashchange", () => {
      const pl = parseHash(window.location.hash);
      if (pl) applyNav(pl);
    });
    if (boot.cleanUrl) window.history.replaceState({}, "", boot.cleanUrl);
    // W45 — deferred so the rest of this instance script (the const helpers it calls) has initialized.
    const googleReturn = boot.googleReturn;
    if (googleReturn) queueMicrotask(() => authFlow.handleGoogleReturn(googleReturn.error));
    if (boot.emailVerify) {
      account.emailVerifyNote = boot.emailVerify;
      if (boot.emailVerify === "ok") queueMicrotask(() => { void refreshAccount().catch(() => {}); });
    }
    // W49 — not deferred: bootResume raises roster.resuming synchronously, and anything that lowers
    // it later would let the lock screen paint first.
    if (boot.resume) void roster.bootResume();
  }
  // The persisted location → hash, mirrored reactively so sub-tab clicks (which set the bound
  // `section`) also update the URL. Anchor is never written here. A change of tab/client pushes a
  // history entry (so back-button walks tabs); a change of only the section replaces in place — a
  // section is backfilled asynchronously when a tab mounts, so pushing it would trap the back-button
  // on the tab. It guards on equality, so this can't loop with the hashchange listener.
  let lastCoarse = "";
  $effect(() => {
    void selectedClientId; void activeTab; void section;
    if (typeof window === "undefined") return;
    const h = toHash({ client: selectedClientId ?? undefined, tab: activeTab, section: section ?? undefined });
    if (window.location.hash === h) return;
    const decision = decideHashSync({ selectedClientId, activeTab }, lastCoarse);
    lastCoarse = decision.nextLastCoarse;
    if (decision.mode === "push") {
      window.location.hash = h;
    } else {
      history.replaceState(null, "", window.location.href.replace(/#.*$/, "") + h);
    }
  });
  async function resolveAnchor(id: string) {
    // The target section mounts lazily, so wait a tick before scrolling/flashing it.
    await tick();
    flashAnchor(id);
  }
  // Apply an incoming permalink (hashchange / pasted link) to the location state, then scroll/flash
  // its anchor. Client is honoured only if it resolves in the current vault; a missing section falls
  // back to the first present one inside ReportSections.
  //
  // M69 fix — a tab switch destroys the old ReportSections instance and mounts a new one, whose own
  // "keep active section valid" effect (ReportSections.svelte:108-110) can race a `section` value set
  // in the same tick, resetting it to that tab's first section before our target ever renders. Wait a
  // tick for the new instance's own effect to settle, then set the real target so it wins — same
  // "mounts lazily" reasoning resolveAnchor already relies on below.
  // M82 Phase 4 — since all non-chat sections now share one stable ReportSections instance (only a
  // chat<->section move still crosses a real remount boundary), this race may now only matter for
  // that one case. Left in place pending manual/e2e confirmation rather than trimmed speculatively.
  // Questions and Glossary are group rows inside Notes now, not top-level sections. Existing
  // permalinks (#client/docInference, #client/definitions) and any saved nav memory still name them
  // directly, so redirect to Notes with that group selected rather than landing on a section with no
  // row.
  //
  // W79 phase 3a — the section-resolution/anchor/reset branching that used to live in applyNav and
  // navigate moved to nav-controller.ts (createNavController, instantiated above as `navController`,
  // aliased to `applyNav`/`navigate` for every existing call site). What's left here is only what the
  // controller calls into: resolveAnchor above, and rememberSection below.
  // M105 — records the section actually settled on by applyNav/navigate, once section is final.
  // Deliberately NOT a reactive $effect watching `section`: ReportSections' own "keep active
  // section valid" effect (see the M69 comment above applyNav) transiently defaults `section` to
  // its first section while the real target is still in flight (the await tick() above gives it
  // that window) — a reactive effect would persist that transient default too. Calling this only
  // from the two navigation functions, after `section` is settled, sees only the real destination.
  function rememberSection() {
    if (section) saveLastSection(selectedClientId, modeForSection(section), section);
  }
  // M105 — on cold start with no explicit deep link (pendingNav unset), land back on the last
  // section remembered for the last-active role/client instead of the hard DEFAULT_TAB.
  function restoreLastLocation() {
    const remembered = loadLastSection(selectedClientId, loadSidebarMode());
    if (remembered) applyNav({ tab: SECTION_TAB[remembered], section: remembered });
  }
  function startChatFromLeaf(pl: Permalink) {
    chatSeedRequest = pl;
    navigate({ tab: "chat", section: undefined });
  }
  // M75 — a sidebar row's "+" action: navigate to its tab/section, then stash the action so the
  // freshly-mounted leaf (or ChatTab) opens its own Add flow. navigate() runs first (clearing any
  // stale pending action as its own first line), so the fresh value set below survives.
  async function triggerSidebarAction(key: string, verb: "new" | "add") {
    // navigate() only flips activeTab when the patch carries a `tab` — Phase 2 dropped `tab` from
    // this function's own params, so decideSidebarAction resolves the section's owning tab itself
    // (same lookup parseHash uses) or a "+"-action fired while on Chat would leave activeTab stuck
    // on "chat".
    const decision = decideSidebarAction(key, verb, SECTION_TAB);
    await navigate(decision.navigate);
    // M76 Phase 5 — chat's "new" verb is directly available now (startNewChatThread); it no longer
    // needs the generic pendingSidebarAction relay ChatTab used to consume.
    if (decision.effect === "startNewChatThread") {
      chatSession.startNewChatThread();
      return;
    }
    // M84 — Markers/Reports' "+" opens the existing Import modal directly; it has no per-section
    // Add UI for pendingSidebarAction to relay to.
    if (decision.effect === "openImport") {
      importOpen = true;
      return;
    }
    pendingSidebarAction = decision.pending;
  }

  let currentClient = $derived(
    vault && selectedClientId ? vault.clients[selectedClientId] : null,
  );

  // W62 — the same count the sidebar's notice shows, read from the same function the prompt uses.
  let pinnedQueryCount = $derived(currentClient ? pinnedQueries(currentClient).length : 0);

  // M93 — the measurement system is an account-level display preference (not per-patient — a
  // provider drilling into multiple patients needs their own consistent setting, independent
  // of whichever patient's vault they're viewing). Loaded via refreshAccount() at login/resume;
  // all consumers (Markers/Chat/Export) read it from here.
  let unitSystem = $state<UnitSystem>("imperial");
  // W84 — the persona that voices chat answers and read-aloud; account-level like unitSystem.
  let persona = $state<PersonaId>(DEFAULT_PERSONA);
  async function setPersona(next: PersonaId) {
    persona = next;
    try {
      await savePersona(next);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  // W84 — with Cody selected, any assistant bubble offers "Cody's take" on Lexi's words.
  $effect(() => {
    const p = persona;
    configureRetell(p === "lexi" ? null : { label: `${PERSONAS[p].name}'s take`, voice: p, retell: (text) => personaTake(p, text) });
  });
  // Every login path re-reads the account; the persona rides along so no path can forget it.
  async function refreshAccount() {
    const [, p] = await Promise.all([account.refresh(), loadPersona()]);
    persona = p;
  }
  async function setUnitSystem(next: UnitSystem) {
    unitSystem = next; // optimistic — the toggle reflects the click immediately
    try {
      await updateProfile({ unitSystem: next });
    } catch (e) {
      error = (e as Error).message;
    }
  }

  let searchIndex = $derived(buildSearchIndex(currentClient, chatSession.threads));
  let searchTokens = $derived(filterTokens(searchQuery));
  let searchResults = $derived(
    searchTokens.length === 0 ? [] : searchIndex.filter((l) => matchesTokens(l.searchText, searchTokens)),
  );

  // W67 — the queue itself lives in leaf-regen-queue.svelte.ts now: the dedupe registry, the
  // single-flight guard and the staleness gate are about leaf regeneration, not about being a
  // component. What stays here is what App actually owns — the vault, its key, and the effects that
  // drive the queue from the component lifecycle.
  const leafRegen = createLeafRegenQueue({
    getClient: () => currentClient,
    getClientId: () => selectedClientId,
    getProviderToken: () => providerToken,
    // M55/M56 stale-draft-clobber fix — merge onto whichever client/vault is live right NOW, not the
    // pre-fetch snapshot: the network round-trip can take long enough for a concurrent edit to land
    // and save in the meantime, and merging onto the old snapshot would silently revert it once this
    // regen's own save follows.
    persist: async (pending, id) => {
      const liveClient = selectedClientId === id ? vault?.clients[id] : undefined;
      if (!liveClient || !session.dek || !session.r2Id) return false;
      return persistClient(id, await applyLeafRegen(liveClient, pending, "translate"));
    },
  });

  $effect(() => {
    void currentClient;
    leafRegen.refreshStaleFlag();
  });

  // W62 had a one-time self-heal here: an $effect that computed the re-stamp patch and SAVED it, so a
  // Finding stamped under an older canonicalizer stopped reading stale. W71 removed it, because once
  // staleness itself accounts for older generations (staleness.ts) the save buys nothing and costs
  // two real things.
  //
  // It writes the WHOLE vault — a 459 KB re-encrypt and upload — on load, for a bookkeeping change
  // nobody asked for. And it reassigns `currentClient` while the user is interacting, which `trigger`
  // reads as "the provider switched patients" and bails on: a note saved in that window silently got
  // no Translate. CI caught exactly that on the pilots, twice — the second time only because W71's
  // three new source nodes made the patch non-empty on EVERY load rather than occasionally, which is
  // what turned an intermittent race into a reliable failure.
  //
  // The re-stamp logic is not gone; stamp-migration.ts still owns it and staleness.ts consults it on
  // every read. What is gone is persisting the result.

  // Two sweeps, because they answer different questions — and conflating them double-billed every save.
  //
  // The ON-OPEN pass asks every sweepable node once, when a provider opens a patient. Its key is the
  // patient's identity, NOT the client object: `currentClient` is reassigned by every save, so an
  // effect that reads it is a save-follower, and this one swept all six nodes on each one.
  //
  // That is what collided with the components' own triggers. A component saves and calls
  // `triggerLeafRegen` for its node against the pre-save client; the save then reassigns `vault`, the
  // effect re-fires, and the sweep asks for the SAME node against the post-save client. Two different
  // input signatures, so the dedupe cannot collapse them — one edit, two billed calls, and the second
  // answer overwrites the first. It was invisible while a mid-flight request was silently dropped;
  // W75 stopped dropping them (a second rapid edit deserves its reply), which surfaced it.
  //
  // The AFTER-A-SAVE pass therefore asks only for what no component owns.
  let openSweepKey = $derived(
    currentClient && selectedClientId ? `${selectedClientId}|${providerToken ? "provider" : "patient"}` : null,
  );

  $effect(() => {
    void openSweepKey;
    leafRegen.sweep();
  });

  // W77 — a PDF stored before page counts were kept leaves the report corpus refusing to assemble
  // (CORPUS.md), and only a browser can count its pages. Once per selected client, unawaited: it is
  // a repair of stored data, not part of rendering anything.
  $effect(() => {
    const id = selectedClientId;
    if (id) void healRawPageCounts(id);
  });

  $effect(() => {
    void currentClient;
    leafRegen.sweep(UNOWNED_LEAF_NODES);
  });

  // Directly-callable twin of the sweep: invoked right after a component's own save so the regen
  // doesn't wait for the effect's next re-fire. targetLabels (e.g. the single Study/Treatment row just
  // added or edited) narrows a row-addressable node's response to just that row. force (the manual
  // Translate menu item) bypasses the staleness gate.
  async function triggerLeafRegen(key: string, targetLabels?: string[], force = false) {
    return leafRegen.trigger(key, targetLabels, force);
  }

  async function fetchVaultBlob(id: string): Promise<Uint8Array> {
    const res = await fetch(`/api/vault/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`vault not found (${res.status})`);
    // W70 — remember the version we are about to work from. Every subsequent save states it as
    // If-Match, so a write is refused if the blob moved underneath instead of silently overwriting
    // whatever the other tab (or the clinician) put there. This one line is what arms all seven
    // saveVaultV2 call sites; without it they would all 428.
    rememberVaultEtag(id, res.headers.get("ETag"));
    return new Uint8Array(await res.arrayBuffer());
  }

  // Open the signed-in owner's own vault with the DEK returned by login.
  async function openOwnVault(r2Key: string, d: CryptoKey) {
    const id = vaultIdFromR2Key(r2Key)!;
    const opened = ensureLeafIds(await openVault<Vault>(session, id, d, fetchVaultBlob));
    // Before anything reads attachments or chat, so a reclaimed namespace is readable on first load.
    await reclaimOrphans(opened);
    vault = opened;
    const ids = Object.keys(vault.clients);
    selectedClientId = ids.length === 1 ? ids[0] : null;
    if (pendingNav) { applyNav(pendingNav); pendingNav = null; }
    else restoreLastLocation();
  }

  const authFlow = createAuthFlow({
    getEmail: () => email,
    getPassword: () => password,
    setUnlocking: (busy) => (unlocking = busy),
    setError: (m) => (error = m),
    setGoogleError: (m) => (googleError = m),
    loginPassword,
    loginPasskey,
    signupPassword,
    signupPasskey,
    bootstrapGoogleSession,
    persistSessionKey: (k) => roster.persistSessionKey(k),
    enterAccount: (r) => roster.enterAccount(r),
    markGoogleResume: () => localStorage.setItem(RESUME_MARKER, "google"),
  });

  // W45 — Google OAuth needs a top-level navigation, not a fetch.
  function startGoogle() {
    window.location.href = "/api/auth/google/start";
  }

  // The drill-in ends here, where the vault does: unwrap the envelope with this session's provider
  // key, decrypt, and open the record keeping the provider role for the UI. One body for both consoles
  // — the clinician roster and the audited support console differ in who may ask, not in what happens.
  async function openPatientVault(entry: VaultEntry, providerKey: CryptoKey) {
    const d = await unwrapDEKWithPrivateKey(b64ToBytes(entry.envelope.wrappedDEK), entry.envelope.ephemeralPublicKeyJwk, providerKey);
    const id = vaultIdFromR2Key(entry.r2Key)!;
    vault = ensureLeafIds(await openVault<Vault>(session, id, d, fetchVaultBlob));
    const ids = Object.keys(vault.clients);
    const want = normalizeClientId(entry.ownerAccountId);
    selectedClientId = ids.find((k) => normalizeClientId(k) === want) ?? ids[0] ?? null;
    activeTab = DEFAULT_TAB;
    roster.setEnteredPatient({ email: entry.email, displayName: entry.displayName });
    if (pendingNav) { applyNav(pendingNav); pendingNav = null; }
    else restoreLastLocation();
  }

  // W15/3b — the distinct PROVIDER_TOKEN that authorizes the refresh, delivered to a proven-provider
  // session (the hd_session cookie carries provider-hood now). Absent → refresh stays hidden.
  async function fetchProviderToken() {
    try {
      const res = await fetch("/api/provider-token");
      if (res.ok) providerToken = (await res.json()).token ?? null;
    } catch {
      /* unreachable — refresh control stays hidden */
    }
  }

  // W15/3b — provider-only Finding refresh: stream a fresh Finding, assemble it in-browser, merge
  // into the vault, and save. `refreshProgress` tracks portions-received + current attempt for the
  // button's live state (segmented bar + "Attempt k of K").
  let refreshController: AbortController | null = null;
  async function doRefresh() {
    if (!vault || !currentClient || !selectedClientId || !session.dek || !session.r2Id || !providerToken) return;
    const c = currentClient;
    const id = selectedClientId;
    refreshing = true;
    refreshError = null;
    refreshProgress = null;
    refreshController = new AbortController();
    const token = providerToken;
    try {
      // W65 — core THEN every leaf, through the shared orchestrator. `save` runs after the core and
      // after each leaf, so a cancel keeps what already landed instead of discarding the whole run.
      const { failures, invariants } = await refreshFindingWithLeaves(c, token, id, {
        onProgress: (p) => (refreshProgress = p),
        onStage: (s) => (refreshStage = s),
        onEvent: (ev) => logRefreshEvent(token, ev),
        signal: refreshController.signal,
        save: async (updated) => {
          if (patientSwitchedMidRequest(currentClient, c)) return; // provider switched patients mid-run
          await persistClient(id, updated);
        },
      });
      // A failed leaf is not a failed refresh: the core and every other leaf are saved. Name them so
      // the provider knows which ⋮ → Translate to re-run, rather than finding a stale turn later.
      // buildRefreshMessage reports both, never one or the other — this was an `else if`, which
      // suppressed the invariant report exactly when a leaf had failed — the run most likely to leave
      // the Finding inconsistent, and since W71 the only run that can: a failed leaf now keeps its
      // PREVIOUS answers (rather than blanking the section), and those answers are the ones that can
      // be keyed to a row deleted since. The invariants are how that surfaces.
      const message = buildRefreshMessage(failures, invariants);
      if (message) refreshError = message;
    } catch (e) {
      // A provider cancel aborts the fetch — that's an intentional stop, not a failure to surface.
      if ((e as Error).name === "AbortError") {
        // refreshProgress is reassigned inside refreshFinding's callback (a closure TS can't track), so
        // CFA still thinks it's the `null` it was set to before the try — re-assert the declared type.
        logRefreshEvent(token, { event: "cancelled", attempt: (refreshProgress as RefreshProgress | null)?.attempt ?? 1 });
      } else {
        refreshError = describeAiError(e);
      }
    } finally {
      refreshing = false;
      refreshStage = null;
      refreshController = null;
    }
  }

  function cancelRefresh() {
    refreshController?.abort();
  }

  async function signOut() {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* best-effort; clear locally regardless */ }
    try { await clearAccountKey(); } catch { /* W49 — best-effort; drop the persisted resume key */ }
    localStorage.removeItem(RESUME_MARKER);
    vault = null;
    selectedClientId = null;
    session.signOut();
    roster.reset();
    support.reset();
    vaultAccess.reset();
    account.reset();
    recovery.reset();
    visibilityOpen = false;
    diagnosticsOpen = false;
    providerToken = null;
    signupMode = false;
    email = "";
    password = "";
    refreshing = false;
    refreshError = null;
    error = null;
  }

  // The awaited save: the vault changes only once the write lands, so a failed save leaves it as it was.
  async function persistClient(id: string, client: Client): Promise<boolean> {
    if (!vault || !session.dek || !session.r2Id) return false;
    const next = withClient(vault, id, client);
    await saveVaultV2(next, session.r2Id, session.dek, vaultSink);
    vault = next;
    return true;
  }

  // M57 — every section's Add/Edit/Delete now persists immediately (no more outer Save queuing up
  // a whole-client draft), so it's normal for a second edit to fire before the first's network PUT
  // resolves. Apply the vault update OPTIMISTICALLY (synchronously, before the await) so that second
  // edit's own mutation handler reads an already-current `client` prop instead of a stale one — this
  // is what makes concurrent immediate-persists safe without a hand-rolled request queue. The actual
  // network PUTs still serialize through `saveChain`, purely so we don't fire overlapping fetches;
  // a PUT's own success/failure never touches `vault` again (it was already applied), so out-of-order
  // completions can't roll back a newer optimistic state.
  function saveEdits(updated: Client): void {
    if (!vault || !selectedClientId || !session.dek || !session.r2Id) return;
    const next = withClient(vault, selectedClientId, updated);
    const r2id = session.r2Id;
    const key = session.dek;
    vault = next; // updates currentClient → children see the new baseline on this same tick
    vaultSave.push(() => saveVaultV2(next, r2id, key, vaultSink));
  }

  // W30 — watchlist membership is a per-chart toggle now (not the Profile editor). Clone the
  // current client, add/remove the marker, and persist through the same edit path (re-encrypt + R2).
  // W62 — the body's marker star and the sidebar's Pin are literally the same write now: both go
  // through vault-item-ops, which is where "a marker's pin IS watchlist membership" is stated once.
  function toggleWatchlist(name: string) {
    sidebarTogglePin("marker", name);
  }

  // W61 — the sidebar's per-row actions. The mutation itself is a pure function (vault-item-ops.ts)
  // and lands through the same saveEdits() path every other edit uses, so a sidebar pin and a body
  // pin are the same write — no seventh copy of clone-mutate-persist.
  function sidebarTogglePin(kind: SidebarItemKind, id: string) {
    if (!currentClient) return;
    void saveEdits(togglePinnedIn(currentClient, kind, id));
  }
  function sidebarRename(kind: SidebarItemKind, id: string, text: string) {
    if (!currentClient) return;
    const next = renameIn(currentClient, kind, id, text);
    if (next !== currentClient) void saveEdits(next);
  }
  function sidebarDelete(kind: SidebarItemKind, id: string, label: string) {
    if (!currentClient) return;
    // Confirms, like deleteChatThread: a sidebar row is a small target and this is user-entered
    // patient data, which the repo's standing rule says must never be lost by accident.
    if (!confirm(`Delete "${label}"? This can't be undone.`)) return;
    void saveEdits(removeFrom(currentClient, kind, id));
  }
  function sidebarLabelOf(kind: SidebarItemKind, id: string): string {
    return currentClient ? labelOf(currentClient, kind, id) : "";
  }

  function togglePinnedRatio(name: string) {
    sidebarTogglePin("ratio", name);
  }

  // M59/Phase 4 — provider-only per-marker Ranges Translate: fill in a personalized range for a
  // single marker that has none yet. A plain non-streamed POST (unlike doRefresh's Finding stream),
  // so no progress/abort plumbing. Throws on failure so MarkerChart's own doTranslate can surface the
  // error scoped to that one marker instead of the page-level refreshError.
  async function translateMarker(client: Client, marker: string): Promise<void> {
    if (!currentClient) return;
    const c = currentClient;
    const range = await fetchPersonalizedRange(client, marker, providerToken);
    if (patientSwitchedMidRequest(currentClient, c)) return;
    saveEdits({ ...c, personalizedRanges: { ...c.personalizedRanges, [marker]: range } });
  }

  // M95 — web-triggered marker->body-system classification: self-service (zero-knowledge-vault)
  // accounts can't reach the CLI's --refresh-marker-groups, which only ever touches a local
  // vault.json. Mirrors translateMarker's shape (throws on failure so MarkersTab's own pending/
  // error state can surface it scoped to that trigger; success persists via the normal saveEdits
  // path, same as every other in-app mutation) — no providerToken precondition, so the account
  // owner's own session (cookie auth, no token) works too.
  async function handleCategorizeMarkers(client: Client): Promise<void> {
    if (!currentClient) return;
    const c = currentClient;
    const markerGroups = await refreshMarkerGroups(client, { providerToken: providerToken ?? undefined });
    if (patientSwitchedMidRequest(currentClient, c)) return;
    saveEdits({ ...c, markerGroups });
  }

  // M60/Phase 1A — after an import, silently backfill personalized ranges for markers that don't
  // have one yet (fill-missing, not force-all — an existing range is left alone). Eligibility
  // mirrors MarkersTab.svelte's translateAll: a resolvable, non-empty unit in client.results.
  // Routes through translateMarker itself (same fetch shape + saveEdits persist), so a provider
  // viewing another patient still sends the bearer while a patient's own session falls back to
  // cookie auth (translateMarker's providerToken precondition was dropped for this). Fire-and-forget
  // from the caller; failures here are silent — MarkerChart's per-marker Translate button already
  // covers a marker that didn't get filled.
  async function fillMissingRanges(client: Client): Promise<void> {
    const eligible = eligibleMarkersForRangeFill(client);
    if (eligible.length === 0) return;
    await runWithConcurrency(eligible, 4, async (marker) => {
      try {
        await translateMarker(client, marker);
      } catch {
        // best-effort fill — see comment above.
      }
    });
  }

  // W15/1 — a web report import folded the report into `updated` (client-side);
  // persist it exactly like an edit (re-encrypt + sink), then swap it into the vault
  // so Health Reports + the stale chips recompute. ImportTab handles the raw PUT.
  async function handleImported(updated: Client, reportId?: string) {
    if (!selectedClientId || !(await persistClient(selectedClientId, updated))) return;
    void fillMissingRanges(updated);
    // W38/5 — headline case: after a report import, close the modal and auto-follow to it in
    // Reports, highlighted (no confirming click).
    if (reportId) {
      importOpen = false;
      navigate({ tab: "labs", section: "healthReports", anchor: reportAnchor(reportId) });
    }
  }

  async function importChatFile(file: File): Promise<ChatImportResult> {
    if (!currentClient || !selectedClientId || !session.dek || !session.r2Id) return { ok: false, message: "No active client." };
    return importFileForChat(currentClient, selectedClientId, file, {
      storeOriginal: putRaw,
      persist: async (id, next) => {
        if (!(await persistClient(id, next))) return false;
        void fillMissingRanges(next);
        return true;
      },
    });
  }

  // W46 — first-run: a signed-in account with an empty vault ({clients:{}}) has no browser way
  // to create a patient. Mint the first Client (keyed by the lowercased account id so a granted
  // provider can resolve it, App.svelte enterPatient), persist like an edit, select it, then open
  // Import so the user lands in "import files to get started".
  async function createFirstClient(info: Record<string, unknown>) {
    if (!vault) return;
    const birthYear = info.birthYear as number | undefined;
    const gender = info.gender as "male" | "female";
    const { id } = await getMyAccount();
    const clientId = normalizeClientId(id);
    // W47 — no name asked; use a neutral label (editable later in Personalization). Birth year → a
    // Jan-1 dob string, which every dob consumer (ageYears via new Date) reads at year precision; a
    // skipped year is an empty dob (age renders as null, no clinical default).
    const dob = birthYear ? `${birthYear}-01-01` : "";
    const client: Client = { displayName: "My records", dob, gender, watchlist: [], results: [] };
    if (!(await persistClient(clientId, client))) return;
    selectedClientId = clientId;
    importOpen = true;
  }

  let tabLabel = $derived(TABS.find((t) => t.id === activeTab)?.label ?? "");
  // M62/Phase 1 — the real on-screen height of whatever renders above the sidebar/shell, measured
  // (not guessed), so the sidebar's sticky/fixed positioning and the mobile scrim account for it.
  // M78 Phase 15 — the header is gone; this now measures the verify/recovery banner area (0 when
  // none is showing) instead of the old header's own height.
  let headerH = $state(0);
  let shellTop = $derived(headerH);
  let sidebarExpanded = $state(true);
  let sidebarMobileOpen = $state(false);
  // M76 Phase 1 — sidebar lower-zone selection (Markers/Treatment/Hypothesis groups), keyed by section.
  // M105 — the remembered group (persisted per client via nav-memory.ts, replacing the old in-memory
  // lastGroupBySection map, which bled one client's remembered group onto another client's section
  // since it wasn't scoped by client at all) is saved explicitly wherever a group is deliberately
  // picked (Sidebar's onSelectGroup below), not via a reactive effect on `activeGroup` — the same
  // ReportSections-internal-default race documented at rememberSection above applies here too.
  let activeGroup = $state<string | null>(null);
  // W62 — the child row currently selected, when a section filters by its children (Notes > Markers,
  // Analysis). It follows activeGroup's lifecycle exactly: picking a GROUP clears it (you asked for
  // the whole group), and every section change clears it alongside activeGroup, or a stale child key
  // from the previous section would narrow the new one to nothing.
  let activeLeaf = $state<string | null>(null);
  // Default/restore group on arrival at a group-bearing leaf. applyNav/navigate null out
  // activeGroup on every section change (M82 Phase 4 — prevents a stale activeGroup from the
  // PREVIOUS section bleeding into the new one before its own default can run), so this effect
  // covers both cases the same way: a section with a remembered selection (a revisit) restores it;
  // one with none yet (first-ever visit) defaults. Without the restore half, the remembered location
  // was write-only — it blocked re-defaulting on a revisit but nothing ever re-applied the
  // remembered value, so returning to a section after visiting any other left activeGroup stuck at
  // null (no sidebar row active, silently falling back to each tab's own internal default).
  // M96 Phase 1 — every group-bearing section defaults to its "ungrouped" (all-leaves-flat) view
  // except Hypothesis and Exploration, which still default to the first established body system, or
  // null if none yet (M76/Phase 4, M80/Phase 5 — unchanged, out of scope for M96).
  // W48 — "allergies"/"familyHistory" dropped from this set: their sidebar sub-list (Bio/Allergies/
  // Family, nested under "personalization") now navigates via `active` directly, not `activeGroup`
  // — see Sidebar.svelte's "personalization" lowerZoneKind branch.
  // M111 — on cold boot from a hash link (#Alex/treatment/…), `section` is set synchronously
  // (line ~231) well before `selectedClientId` resolves (only set once enterAccount's async
  // vault-unlock chain finishes and applies the pending nav). Without the `selectedClientId` guard,
  // this effect ran on that first pass with a null clientId, `loadLastGroup` returned null (its own
  // `if (!clientId) return null`), and every non-FIRST_SYSTEM_DEFAULT_SECTIONS section defaulted
  // straight to "ungrouped" — a real value, so `!activeGroup` was false on every later run and the
  // remembered group set once the real clientId arrived was never loaded. Every group-bearing
  // section's last-visited submenu was affected on a hard refresh, not just Treatment/Medicine.
  // W79 phase 3a — the branch itself (remembered / first-system-default / section-default / ALL)
  // moved to nav-decisions.ts's resolveDefaultGroup; this effect stays only for the reactive reads
  // and the two impure lookups (loadLastGroup, systemOrder) that decision needs as plain inputs.
  $effect(() => {
    if (section && GROUP_SECTIONS.has(section) && !activeGroup && selectedClientId) {
      const remembered = loadLastGroup(selectedClientId, section);
      const firstSystemDefault = FIRST_SYSTEM_DEFAULT_SECTIONS.has(section)
        ? (currentClient ? (systemOrder(currentClient)[0] ?? null) : null)
        : null;
      activeGroup = resolveDefaultGroup(section, remembered, firstSystemDefault, ALL_GROUP_KEY);
    }
  });
  // M76/Phase 2 — a deep-linked anchor whose owning sidebar group isn't the currently active one
  // (see MarkersTab.svelte's reverse-match effect). Cleared by the leaf once it has resolved and
  // switched activeGroup.
  let pendingAnchor = $state<string | null>(null);
  // M-annotate — any leaf's "Annotate" action drops its attachment here and navigates to the Notes
  // leaf, which seeds its Add modal from it. Source-agnostic: Chat, Markers, Reports, Study, and
  // Hypothesis all funnel through this one handler.
  let pendingNoteAttachment = $state<NoteAttachment | null>(null);
  function createNoteFromAttachment(attachment: NoteAttachment) {
    pendingNoteAttachment = attachment;
    navigate({ tab: 'appointment', section: 'notes' });
  }

  // W79 phase 3a — chat-thread hydration, the fallback-to-first-thread effect, the seed-request
  // effect, debounced persistence, and the five thread actions all moved into `chatSession`
  // (chat-thread-session.svelte.ts, instantiated above), which now owns the thread-list state too.

  // W15/3a bounce, reworked for the flat section list (M82 Phase 4) — Phase 3 flattened Sidebar to a
  // list of sections, so there's no more "whole tab" concept to bounce off; check instead whether the
  // active view (chat, or the active `section`) still resolves to something visible for this
  // audience, reusing the same presence+visibility filter Sidebar's NAV_GROUPS/ReportSections' own
  // `present` derivation already apply, so all three agree on what's visible.
  $effect(() => {
    if (!currentClient) return;
    const client = currentClient;
    const canSeeKey = (key: string) => canSee(roster.isProvider, client, key);
    const visible = presentSections(client, ALL_SECTIONS).map((s) => s.key).filter(canSeeKey);
    const bounce = decideVisibilityBounce({ activeTab, section }, visible, canSeeKey);
    if (bounce) navigate(bounce);
  });
  let aboutOpen = $state(false);
  let exportOpen = $state(false);
  let importOpen = $state(false);
  let dagOpen = $state(false); // provider (roster) view — inspect the Finding DAG structure
  let dagModalOpen = $state(false); // patient view — the same DAG, coloured by staleness for this patient

  // M78 Phase 14 — a top-right kebab mirroring whatever actions the sidebar shows for the active
  // tab/section, via the same Add/New/Import registry (sidebarActionFor now covers Markers/Reports'
  // Import too, M84). Deliberately excludes Translate-all — a stateful bulk action that stays
  // sidebar-only so its busy/summary state is never tracked in two places at once. Export moved to
  // the account menu (M84) — it's no longer sidebar- or kebab-scoped.
  let kebabItems = $derived<LeafMenuItem[]>([
    ...(() => {
      const a = sidebarActionFor(section ?? "chat");
      return a ? [{ label: a.label, onClick: () => triggerSidebarAction(section ?? "chat", a.verb) }] : [];
    })(),
  ]);
</script>

<svelte:head>
  {#if currentClient}
    {@html `<style>
:root { --patient-label: "${currentClient.displayName.replace(/[\\\\"]/g, "\\$&")}"; --inference-mode: "${currentClient.finding?.generatedBy ? (currentClient.finding.generatedBy.mode === "dev" ? "DEV DRAFT — " : "") + PRODUCT_NAME + " " + currentClient.finding.generatedBy.model : ""}"; }</style>`}
  {/if}
</svelte:head>

<!-- M92 Phase 2 — one shared chrome snippet rendered at the end of every top-level branch below
     (lock, roster ×2, onboarding, the full shell). Previously a single unconditional instance sat
     after this whole if/else-if chain; that placement is what let the shell branch's sticky sidebar
     "unstick" early (its containing block, .shell-row, ended before the page did). Rendering it
     inside .page-container for the shell branch keeps the sidebar's containing block spanning the
     full scrollable height; the other branches call it in their previous (already-correct) spot so
     footer.spec.ts's "renders on every state" coverage still holds. -->
{#snippet appChrome()}
  <Disclaimer />
  <OrgFooter org={FOUNDATION} />
{/snippet}

<div class="app-shell">
<!-- Visually hidden, deliberately: these duplicate messages the page already shows, and exist only so
     assistive tech is told about them. assertive for errors (they interrupt), polite for the save
     confirmation (it must not). -->
<p class="sr-only" role="alert">{announcedError}</p>
<p class="sr-only" role="status" aria-live="polite">{vaultSave.saved ? "Saved" : ""}</p>
<SpeechControls />
<div class="app-body">
<!-- M78 Phase 15 — measures whatever renders in this banner area (0 when nothing is showing),
     now that there's no header to measure instead. -->
<div bind:clientHeight={headerH}>
<!-- W47/W48 — non-blocking email verification banner; global so it shows in patient AND provider/roster views. -->
{#if account.emailVerifyNote === "ok"}
  <div class="verify-banner ok">Email verified — thanks.<button class="verify-x" onclick={() => (account.emailVerifyNote = null)} aria-label="Dismiss">✕</button></div>
{:else if account.emailVerifyNote === "sent"}
  <div class="verify-banner ok">Verification email sent. Check your inbox.<button class="verify-x" onclick={() => (account.emailVerifyNote = null)} aria-label="Dismiss">✕</button></div>
{:else if account.emailVerifyNote === "invalid"}
  <div class="verify-banner warn">That verification link was invalid or expired.<button class="verify-link" onclick={() => account.resendVerification()}>Send a new one</button></div>
{:else if account.info?.email && !account.info.emailConfirmed}
  <div class="verify-banner warn">Verify your email ({account.info.email}) to secure your account.<button class="verify-link" onclick={() => account.resendVerification()}>Resend</button></div>
{/if}
<!-- W48 — recovery is no longer forced at signup; nudge (dismissible) until the account has a recovery code. -->
{#if SHOW_RECOVERY_NUDGE && account.info && !account.hasRecovery && !recovery.nudgeDismissed}
  <div class="verify-banner warn recovery-nudge">Set up account recovery so you can get back in if you lose your sign-in.<button class="verify-link" onclick={() => { recovery.nudgeDismissed = true; account.openPanel(); }}>Set up</button><button class="verify-x" onclick={() => (recovery.nudgeDismissed = true)} aria-label="Dismiss">✕</button></div>
{/if}
</div>
{#if roster.resuming}
  <LoginScreen productName={PRODUCT_NAME} resuming={true} recovery={recovery} onLogin={authFlow.login} onSignup={authFlow.signup} onGoogle={startGoogle} />
  {@render appChrome()}
{:else if !vault && !roster.isProvider}
  <!-- W73/W80 — one field for both recovery-code rungs: the endpoint called is read off the code's
       shape (recovery.kind), not a manual pick, so the copy needs no branch of its own. -->
  <LoginScreen
    productName={PRODUCT_NAME}
    bind:email
    bind:password
    bind:signupMode
    bind:error
    {unlocking}
    {googleError}
    recovery={recovery}
    onLogin={authFlow.login}
    onSignup={authFlow.signup}
    onGoogle={startGoogle}
    signUpSubheading="Create your account. Your record is encrypted end-to-end, and LexiTar holds a recovery key so a forgotten password doesn't lose it — removable any time in Account settings."
  />
  {@render appChrome()}
{:else if support.isSupportSession && !vault}
  <header class="app-header">
    <div class="brand">{PRODUCT_NAME}</div>
    <div class="header-spacer"></div>
    <AccountMenu
      email={account.info?.email ?? null}
      emailConfirmed={account.info?.emailConfirmed ?? true}
      onAccount={() => account.openPanel()}
      onResendVerification={() => account.resendVerification()}
      onSignOut={signOut}
    />
  </header>
  <main class="roster">
    {#if support.providerView}
      <button class="header-link roster-back" onclick={() => support.closeProvider()}>← Back to console</button>
      <p class="sub">Roster of <strong>{support.providerView.displayName}</strong> — {support.providerView.roster.length} patient{support.providerView.roster.length === 1 ? "" : "s"}. You can open a record only where that patient has granted you access.</p>
      {#if support.providerView.roster.length > 0}
        <ul class="roster-list">
          {#each [...support.providerView.roster].sort((a, b) => a.displayName.localeCompare(b.displayName)) as p (p.ownerAccountId)}
            <li>
              {#if p.openable}
                <button class="roster-name" onclick={() => support.enterPatient(p.ownerAccountId)}>{p.displayName}</button>
              {:else if p.pending}
                <span class="roster-name roster-name-disabled">{p.displayName}<span class="access-kind">requested · awaiting approval</span></span>
              {:else}
                <span class="roster-name roster-name-disabled">{p.displayName}<span class="access-kind">no access</span></span>
                {#if p.email}<button class="roster-request" title="Request access from this patient" onclick={() => { support.requestEmail = p.email ?? ""; support.requestAccess(); }}>Request access</button>{/if}
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="access-empty">This provider has no patients.</p>
      {/if}
    {:else}
      <p class="sub">Support console. Access is time-boxed and audited.</p>
      <p class="access-subhead">Patients ({support.patients.length})</p>
      {#if support.patients.length > 0}
        <ul class="roster-list">
          {#each [...support.patients].sort((a, b) => a.displayName.localeCompare(b.displayName)) as p (p.ownerAccountId)}
            <li><button class="roster-name" onclick={() => support.enterPatient(p.ownerAccountId)}>{p.displayName}{#if p.expiresAt}<span class="access-kind">until {new Date(p.expiresAt).toLocaleString()}</span>{/if}</button></li>
          {/each}
        </ul>
      {:else}
        <p class="access-empty">No patients have granted you access yet.</p>
      {/if}
      {#if support.providers.length > 0}
        <p class="access-subhead">Providers ({support.providers.length})</p>
        <ul class="roster-list">
          {#each [...support.providers].sort((a, b) => a.displayName.localeCompare(b.displayName)) as p (p.providerAccountId)}
            <li><button class="roster-name" onclick={() => support.openProvider(p)}>{p.displayName}<span class="access-kind">provider roster{#if p.expiresAt} · until {new Date(p.expiresAt).toLocaleString()}{/if}</span></button></li>
          {/each}
        </ul>
      {/if}
      {#if support.requests.length > 0}
        <p class="access-subhead">Pending requests ({support.requests.length})</p>
        <ul class="roster-list">
          {#each [...support.requests].sort((a, b) => a.displayName.localeCompare(b.displayName)) as r (r.linkId)}
            <li>
              <span class="roster-name roster-name-disabled">{r.displayName || r.email}<span class="access-kind">{r.kind} · awaiting approval</span></span>
              <button class="roster-remove" title="Cancel this request" onclick={() => support.cancelRequest(r.linkId)}>Cancel</button>
            </li>
          {/each}
        </ul>
      {/if}
      <form class="access-add" onsubmit={(e) => { e.preventDefault(); support.requestAccess(); }}>
        <input type="email" placeholder="patient or provider email" aria-label="Patient or provider email" bind:value={support.requestEmail} />
        <button type="submit" class="access-add-btn" disabled={!support.requestEmail.trim()}>Request access</button>
      </form>
    {/if}
    {#if error}<p class="err">{error}</p>{/if}
  </main>
  {@render appChrome()}
{:else if roster.isProvider && !vault}
  <header class="app-header">
    <div class="brand">{PRODUCT_NAME}</div>
    <div class="header-spacer"></div>
    <button class="header-link" onclick={() => (dagOpen = !dagOpen)}>{dagOpen ? "← Back to clients" : "Translation DAG"}</button>
    <AccountMenu
      email={account.info?.email ?? null}
      emailConfirmed={account.info?.emailConfirmed ?? true}
      onAccount={() => account.openPanel()}
      onResendVerification={() => account.resendVerification()}
      onSignOut={signOut}
    />
  </header>
  {#if dagOpen}
    <main class="roster wide"><FindingDag /></main>
  {:else}
    <main class="roster">
      <p class="sub">Provider view — {roster.patients.length} patient{roster.patients.length === 1 ? "" : "s"}. Select one to open their record.</p>
      {#if vaultAccess.pendingSupport.length > 0}
        <div class="access-pending">
          <p class="access-subhead">Support access requests</p>
          <ul class="access-list">
            {#each vaultAccess.pendingSupport as p (p.linkId)}
              <li>
                <span class="access-who"><strong>{p.displayName}</strong> <span class="access-kind">support · wants your roster</span></span>
                <span class="access-approve-actions">
                  <select bind:value={vaultAccess.ttlHours} disabled={vaultAccess.busy} title="How long support may access your roster">
                    <option value={24}>24h</option>
                    <option value={72}>3 days</option>
                    <option value={168}>7 days</option>
                  </select>
                  <button class="access-approve" disabled={vaultAccess.busy} onclick={() => vaultAccess.approveAsProvider(p)}>Approve</button>
                  <button class="access-revoke" disabled={vaultAccess.busy} onclick={() => vaultAccess.revokeAsProvider(p)}>Deny</button>
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if vaultAccess.activeSupport.length > 0}
        <div class="access-pending">
          <p class="access-subhead">Support agents with roster access</p>
          <ul class="access-list">
            {#each vaultAccess.activeSupport as p (p.linkId)}
              <li>
                <span class="access-who"><strong>{p.displayName}</strong> <span class="access-kind">support{#if p.expiresAt} · until {new Date(p.expiresAt).toLocaleString()}{/if}</span></span>
                <button class="access-revoke" disabled={vaultAccess.busy} onclick={() => vaultAccess.revokeAsProvider(p)}>Revoke</button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if error}<p class="err">{error}</p>{/if}
      <ul class="roster-list">
        {#each [...roster.patients].sort((a, b) => roster.label(a).localeCompare(roster.label(b))) as p (p.ownerAccountId)}
          <li>
            <button class="roster-name" onclick={() => roster.enterPatient(p)}>{roster.label(p)}</button>
            <button class="roster-recover" title="Issue a one-time recovery code to read to this patient" onclick={() => recovery.issueForPatient(p)}>Recovery code</button>
            <button class="roster-remove" title="Remove this patient from your roster" onclick={() => roster.removeFromRoster(p)}>Remove</button>
          </li>
        {/each}
      </ul>
      {#if recovery.issuedFor}
        <RecoveryCodeDialog
          patientName={roster.label(recovery.issuedFor)}
          code={recovery.issuedCode}
          expiresAt={recovery.issuedExpiresAt}
          busy={recovery.issuing}
          error={recovery.issueError}
          onClose={() => recovery.closeIssueDialog()}
        />
      {/if}
    </main>
  {/if}
  {@render appChrome()}
{:else if vault && !roster.isProvider && Object.keys(vault.clients).length === 0}
  <Onboarding
    productName={PRODUCT_NAME}
    fields={[
      { key: "birthYear", kind: "number", label: "Birth year", placeholder: "e.g. 1980", min: 1900, max: new Date().getFullYear(), invalidMessage: "Enter a valid birth year." },
      { key: "gender", kind: "select", label: "Sex", options: [{ value: "male", label: "Male" }, { value: "female", label: "Female" }] },
    ] satisfies OnboardingField[]}
    defaults={{ birthYear: null, gender: "male" }}
    onCreate={createFirstClient}
    onSignOut={signOut}
  />
  {@render appChrome()}
{:else if vault}
  <!-- M78 Phase 13 — the mobile sidebar-drawer toggle, its own fixed corner button, mobile-only.
       M78 Phase 15 — the header that used to hold this (and everything else, across phases 5-14)
       is gone; the sidebar is now the only chrome. -->
  <button class="sidebar-toggle" aria-label="Menu" onclick={() => (sidebarMobileOpen = !sidebarMobileOpen)}>☰</button>

  <!-- M78 Phase 14 — a fixed top-right kebab mirroring the sidebar's own actions for whichever
       tab/section is active (contents change as you navigate; hidden when there's nothing to
       offer for the current section). -->
  {#if currentClient && kebabItems.length > 0}
    <div class="page-kebab">
      <LeafActionMenu label="Section actions" items={kebabItems} />
    </div>
  {/if}

  {#if vaultConflict}
    <!-- W70 — blocking on purpose. No backdrop dismiss, no Escape, no default button: a save was
         refused because this record changed elsewhere, and BOTH versions are real work. Nothing is
         discarded without the patient choosing which. Editing is blocked underneath, so more work
         cannot pile onto a frozen queue. -->
    <div class="conflict-backdrop" role="presentation">
      <div class="conflict-panel" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" aria-describedby="conflict-body">
        <h2 id="conflict-title">This record changed somewhere else</h2>
        <p id="conflict-body">
          It was edited in another tab or on another device while you were working. <strong>Nothing has
          been lost yet</strong>, but this tab can't save until you choose what to keep.
        </p>
        <div class="conflict-actions">
          <Button primary disabled={resolvingConflict} onclick={resolveConflictKeepMine}>
            Keep this tab's version <span class="conflict-hint">(replaces the other one)</span>
          </Button>
          <Button disabled={resolvingConflict} onclick={resolveConflictTakeTheirs}>
            Discard my changes here and reload <span class="conflict-hint">(keeps the other one)</span>
          </Button>
        </div>
        {#if resolvingConflict}<p class="conflict-working">working…</p>{/if}
      </div>
    </div>
  {/if}
  {#if aboutOpen}<AboutOverlay onClose={() => (aboutOpen = false)} translationModel={currentClient?.finding?.generatedBy ?? null} />{/if}
  {#if exportOpen}
    {@const v = vault}
    <Modal label="Export" onClose={() => (exportOpen = false)}>
      <ExportTab
        lead="Take this record out of the dashboard. Everything here is generated on your device — nothing is sent anywhere."
        options={[
          {
            key: "csv",
            title: "Markers (CSV)",
            description: "Every marker reading across the vault as a spreadsheet — one row per reading, in your chosen unit system.",
            buttonLabel: `↓ Download CSV (${unitSystem === "imperial" ? "lb" : "kg"})`,
            onClick: () => exportCsv(v, unitSystem, today),
          },
          {
            key: "json",
            title: "Full record (JSON)",
            description: "A structured machine-readable slice — demographics, factors, watchlist, every reading, and the Translation — for a provider's system or your own tooling.",
            buttonLabel: "↓ Download JSON",
            onClick: () => exportJson(v, today),
          },
          {
            key: "email",
            title: "Email / share",
            description: "Send the handoff to a provider. This moves data off your device, so it's gated behind the upcoming privacy/retention work (W9c).",
            buttonLabel: "✉ Email",
            disabled: true,
            badge: "coming soon",
          },
        ] satisfies ExportOption[]}
      />
    </Modal>
  {/if}
  {#if importOpen}
    <Modal label="Import" onClose={() => (importOpen = false)}>
      <ImportTab client={currentClient} clientId={selectedClientId} onImported={handleImported} />
    </Modal>
  {/if}
  {#if dagModalOpen && currentClient}
    <Modal label="Translation DAG" onClose={() => (dagModalOpen = false)}>
      <FindingDag client={currentClient} />
    </Modal>
  {/if}
  {#if visibilityOpen && currentClient}
    <Modal label="Patient visibility" onClose={() => (visibilityOpen = false)}>
      <VisibilitySettings
        subjectLabel={currentClient.displayName}
        features={FEATURES}
        isVisible={(key) => patientCanSee(currentClient, key)}
        onSave={(key, visible) => handleImported({ ...currentClient, patientVisibility: { ...currentClient.patientVisibility, [key]: visible } })}
        viewerLabel="You (the provider)"
      />
    </Modal>
  {/if}
  {#if diagnosticsOpen && providerToken}
    <Modal label="Translation diagnostics" wide onClose={() => (diagnosticsOpen = false)}>
      <Diagnostics
        token={providerToken}
        fetchLog={fetchRefreshLog}
        noteText="PHI-free operational trail of recent translations — outcome, attempts, and token cost. Newest first (times UTC)."
        emptyText="No translation events recorded yet."
      />
    </Modal>
  {/if}
  {#if vaultAccess.open}
    <Modal label="Access" onClose={() => vaultAccess.closePanel()}>
      <div class="access-panel">
        <p class="access-intro">People who can access your record. Adding a provider shares this record with them; revoking removes their access.</p>
        {#if vaultAccess.pendingSupport.length > 0}
          <div class="access-pending">
            <p class="access-subhead">Support access requests</p>
            <ul class="access-list">
              {#each vaultAccess.pendingSupport as p (p.linkId)}
                <li>
                  <span class="access-who"><strong>{p.displayName}</strong> <span class="access-kind">support · wants to help</span></span>
                  <span class="access-approve-actions">
                    <select bind:value={vaultAccess.ttlHours} disabled={vaultAccess.busy} title="How long support may access your record">
                      <option value={24}>24h</option>
                      <option value={72}>3 days</option>
                      <option value={168}>7 days</option>
                    </select>
                    <button class="access-approve" disabled={vaultAccess.busy} onclick={() => vaultAccess.approve(p)}>Approve</button>
                    <button class="access-revoke" disabled={vaultAccess.busy} onclick={() => vaultAccess.revoke(p)}>Deny</button>
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        {#if vaultAccess.activeAccess.length === 0}
          <p class="access-empty">No one else can access your record.</p>
        {:else}
          <ul class="access-list">
            {#each vaultAccess.activeAccess as p (p.linkId)}
              <li>
                <span class="access-who"><strong>{p.displayName}</strong> <span class="access-kind">{p.kind}{#if p.kind === "support" && p.expiresAt} · until {new Date(p.expiresAt).toLocaleString()}{/if}</span></span>
                <button class="access-revoke" disabled={vaultAccess.busy} onclick={() => vaultAccess.revoke(p)}>Revoke</button>
              </li>
            {/each}
          </ul>
        {/if}
        <form class="access-add" onsubmit={(e) => { e.preventDefault(); vaultAccess.addProvider(); }}>
          <input type="email" placeholder="provider@example.com" aria-label="Provider email" bind:value={vaultAccess.newProviderEmail} disabled={vaultAccess.busy} />
          <button type="submit" class="access-add-btn" disabled={vaultAccess.busy || !vaultAccess.newProviderEmail.trim()}>Add provider</button>
        </form>
        {#if vaultAccess.error}<p class="access-error">{vaultAccess.error}</p>{/if}
      </div>
    </Modal>
  {/if}
  <div class="shell-row" style="--shell-top: {shellTop}px">
  <Sidebar
    activeTab={activeTab}
    client={currentClient}
    providerSession={roster.isProvider}
    active={section}
    {activeGroup}
    bind:expanded={sidebarExpanded}
    bind:mobileOpen={sidebarMobileOpen}
    onNavigate={navigate}
    onAction={triggerSidebarAction}
    onSelectGroup={(key) => { activeGroup = key; activeLeaf = null; if (section) saveLastGroup(selectedClientId, section, key); }}
    onSelectLeafKey={(key) => (activeLeaf = key)}
    threads={chatSession.threads}
    bind:renamingId={chatSession.renamingId}
    bind:renameText={chatSession.renameText}
    onSelectThread={chatSession.selectChatThread}
    onTogglePinThread={chatSession.toggleChatThreadPin} onSidebarTogglePin={sidebarTogglePin} onSidebarRename={sidebarRename} onSidebarDelete={sidebarDelete} sidebarLabelOf={sidebarLabelOf}
    onDeleteThread={chatSession.deleteChatThread}
    onCommitRename={chatSession.commitChatRename}
    {searchOpen}
    onOpenSearch={() => { searchOpen = true; searchFocusToken++; }}
    onFreshSearch={() => { searchQuery = ""; searchOpen = true; searchFocusToken++; }}
    bind:windowYears
    productName={PRODUCT_NAME}
    {vault}
    {selectedClientId}
    {providerToken}
    {refreshing}
    {refreshProgress}
    {refreshStage}
    {refreshError}
    onCancelRefresh={cancelRefresh}
    onDismissRefreshError={() => (refreshError = null)}
    saveError={vaultSave.error}
    onRetrySave={() => vaultSave.retry()}
    findingStale={leafRegen.stale}
    onOpenDag={() => (dagModalOpen = true)}
    {unitSystem}
    onSetUnitSystem={setUnitSystem}
    {persona}
    onSetPersona={setPersona}
  >
    {#snippet accountArea()}
      {#if roster.isProvider}
        <AccountMenu
          email={roster.enteredPatient?.email ?? roster.enteredPatient?.displayName ?? null}
          providerAccess
          subjectFallback="patient"
          viewingSubjectLabel="Viewing patient"
          backToRosterLabel="← Back to roster"
          translateBusyTitle="The Translation is being generated — this takes a few minutes"
          onBackToRoster={() => roster.backToRoster()}
          onSignOut={signOut}
          onTranslate={currentClient && providerToken ? doRefresh : undefined}
          translating={refreshing}
          translateTitle={currentClient
            ? [
                currentClient.finding?.generatedAt
                  ? `Last translated ${timeAgo(currentClient.finding.generatedAt, Date.now())} · Regenerate this patient's Translation (provider only)`
                  : `Regenerate this patient's Translation (provider only)`,
                // W62 — the provider triggering a regeneration is told, at the moment of triggering,
                // that starred items will steer it. The sidebar notice says the same thing to
                // whoever does the starring; between them a pin is never silent.
                pinnedQueryCount > 0
                  ? `${pinnedQueryCount} starred item${pinnedQueryCount === 1 ? "" : "s"} will be passed as areas of query — topics to look into, never as evidence`
                  : null,
              ].filter(Boolean).join(" · ")
            : undefined}
          onDiagnostics={providerToken ? () => (diagnosticsOpen = true) : undefined}
          onVisibility={currentClient ? () => (visibilityOpen = true) : undefined}
          onDag={currentClient?.finding ? () => (dagModalOpen = true) : undefined}
          onExport={currentClient ? () => (exportOpen = true) : undefined}
          onAbout={() => (aboutOpen = true)}
        />
      {:else}
        <AccountMenu
          email={account.info?.email ?? null}
          emailConfirmed={account.info?.emailConfirmed ?? true}
          onAccount={() => account.openPanel()}
          onAccess={() => vaultAccess.openPanel()}
          accessLabel="Who can access my record"
          onResendVerification={() => account.resendVerification()}
          onSignOut={signOut}
          onExport={currentClient ? () => (exportOpen = true) : undefined}
          onAbout={() => (aboutOpen = true)}
        />
      {/if}
    {/snippet}
  </Sidebar>
  <div class="page-container">
  <main class="tab-content" aria-label={tabLabel}>
    {#if !currentClient}
      <p class="needs-client">Select a patient above to use {tabLabel}.</p>
    {:else if searchOpen}
      <SearchPanel
        results={searchResults}
        bind:query={searchQuery}
        focusToken={searchFocusToken}
        client={currentClient}
        clientId={selectedClientId}
        {unitSystem}
        {windowYears}
        onStartChat={startChatFromLeaf}
        onPin={sidebarTogglePin}
        onSelect={(leaf) => {
          if (leaf.section === "chat") {
            navigate({ tab: "chat", section: leaf.anchor });
          } else {
            navigate({ tab: leaf.matchTab, section: leaf.section, anchor: leaf.anchor });
          }
        }}
        onClose={() => (searchOpen = false)}
      />
    {:else if activeTab === "chat" && currentClient}
      <ChatTab client={currentClient} dek={session.dek} clientId={selectedClientId} {unitSystem} {persona} activeId={section} bind:threads={chatSession.threads} hydrated={chatSession.hydrated} {vault} onNavigate={navigate} onPersist={chatSession.persistChatThreads} onImportFile={importChatFile} onCreateNote={createNoteFromAttachment} />
    {:else if currentClient}
      <ReportSections client={currentClient} sections={ALL_SECTIONS} bind:active={section} clientId={selectedClientId} providerSession={roster.isProvider} canTranslate={roster.isProvider && !!providerToken} onTranslate={translateMarker} onCategorizeMarkers={handleCategorizeMarkers} {vault} {unitSystem} bind:windowYears onToggleWatchlist={toggleWatchlist} onTogglePinnedRatio={togglePinnedRatio} onSave={saveEdits} onSaved={(anchor) => navigate({ anchor })} onTriggerRegen={triggerLeafRegen} saved={vaultSave.saved} saveError={vaultSave.error} onStartChat={startChatFromLeaf} onCreateNote={createNoteFromAttachment} pendingSidebarAction={pendingSidebarAction} onConsumeSidebarAction={() => (pendingSidebarAction = null)} bind:activeGroup {activeLeaf} {pendingAnchor} onConsumeAnchor={() => (pendingAnchor = null)} pendingNoteAttachment={pendingNoteAttachment} onPendingNoteAttachmentConsumed={() => (pendingNoteAttachment = null)} onNavigate={navigate} />
    {/if}
  </main>
  {@render appChrome()}
  </div>
  </div>
{/if}
</div>
</div>

<!-- W48 — Account modal at top level so it opens from patient view AND provider/roster views. -->
{#if account.open}
  <Modal label="Account" onClose={() => { account.closePanel(); recovery.closeAccountBlocks(); }}>
    <div class="access-panel">
      <p class="access-subhead">Profile</p>
      <form class="account-profile" onsubmit={(e) => { e.preventDefault(); account.saveProfile(); }}>
        <label>Display name <span class="field-row"><input type="text" bind:value={account.editDisplayName} disabled={account.busy} /><DictateButton onResult={(t) => (account.editDisplayName = account.editDisplayName ? `${account.editDisplayName} ${t}` : t)} /></span></label>
        <label>Email <input type="email" bind:value={account.editEmail} disabled={account.busy} /></label>
        {#if account.info && account.info.email && !account.info.emailConfirmed}
          <p class="access-kind">Email not yet confirmed.</p>
        {/if}
        <button type="submit" disabled={account.busy}>Save profile</button>
      </form>

      <p class="access-subhead">Sign-in methods</p>
      <ul class="access-list">
        {#each account.loginMethods as m (m.method)}
          <li>
            <span class="access-who"><strong>{m.method === "passkey" ? "Passkey" : m.method === "password" ? "Password" : m.method === "google" ? "Google" : m.method}</strong></span>
            <button class="access-revoke" disabled={account.busy || !!account.removeBlockedReason(m.method as RemovableMethod)} title={account.removeBlockedReason(m.method as RemovableMethod) ?? "Remove"} onclick={() => account.remove(m.method as RemovableMethod)}>Remove</button>
          </li>
        {/each}
      </ul>
      <div class="account-add">
        {#if !account.hasPasskey}<button disabled={account.busy} onclick={() => account.addPasskey()}>Add a passkey</button>{/if}
        {#if !account.hasGoogle}<button disabled={account.busy} onclick={() => account.connectGoogle()}>Connect Google</button>{/if}
        {#if !account.hasPassword}
          <form class="access-add" onsubmit={(e) => { e.preventDefault(); account.addPassword(); }}>
            <input type="password" placeholder="new password" aria-label="New password" bind:value={account.newPassword} disabled={account.busy} />
            <button type="submit" class="access-add-btn" disabled={account.busy || !account.newPassword}>Add password</button>
          </form>
        {/if}
      </div>

      <p class="access-subhead">Recovery code</p>
      <p class="access-intro">Your backup way in if you lose your password and passkey. Generate one and keep it somewhere safe; generating again replaces any previous code.</p>
      {#if recovery.regeneratedCode}
        <p class="access-kind">Save this code — it's shown once:</p>
        <p class="recovery-code">{recovery.regeneratedCode}</p>
      {/if}
      <div class="account-add">
        <button disabled={account.busy} onclick={() => recovery.regenerate()}>{account.hasRecovery ? "Regenerate recovery code" : "Generate recovery code"}</button>
      </div>

      {#if !roster.isProvider}
        <p class="access-subhead">Recovery key</p>
        {#if recovery.orgHeld}
          <p class="access-intro">LexiTar holds a key that can open your record if you lose your password. Every use of it is listed below.</p>
          {#if recovery.revokeConfirm}
            <p class="access-kind">Remove the recovery key? Your record stays encrypted with your password alone. If you forget it, nobody can recover this record — not you, not LexiTar.</p>
            <div class="account-add">
              <button class="access-revoke" disabled={account.busy} onclick={() => recovery.revokeOrgKey()}>Yes, remove it</button>
              <button disabled={account.busy} onclick={() => (recovery.revokeConfirm = false)}>Cancel</button>
            </div>
          {:else}
            <div class="account-add">
              <button class="access-revoke" disabled={account.busy} onclick={() => (recovery.revokeConfirm = true)}>Remove recovery key</button>
            </div>
          {/if}
        {:else}
          <p class="access-intro">Removed {recovery.orgRevokedAt ? new Date(recovery.orgRevokedAt).toLocaleString() : ""}. Your password is the only key to this record.</p>
        {/if}
        <ul class="access-list access-events">
          {#each accessEvents as ev (ev.id)}
            <li><span class="access-who">{ev.action} · {new Date(ev.createdAt).toLocaleString()}</span></li>
          {:else}
            <li><span class="access-who">No one has opened your record.</span></li>
          {/each}
        </ul>
      {/if}
      {#if account.error}<p class="access-error">{account.error}</p>{/if}
    </div>
  </Modal>
{/if}

<!-- W46 Phase 4 — the one shared hidden file input every leaf's "Attach" action drives via
     attach-controller.ts, mounted unconditionally so it's present regardless of view state
     (login, roster, patient view, print). -->
<AttachPicker />

<style>
  /* W70 — the conflict surface. Deliberately not the shared Modal: that one dismisses on backdrop
     click and Escape, which is exactly what must not happen here. */
  .conflict-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center; z-index: 200; padding: 1rem;
  }
  .conflict-panel {
    background: var(--surface); color: var(--fg); border-radius: 10px;
    padding: 1.25rem 1.5rem; max-width: 30rem; box-shadow: 0 10px 40px rgba(0,0,0,0.35);
  }
  .conflict-panel h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
  .conflict-panel p { margin: 0 0 1rem; line-height: 1.45; }
  .conflict-actions { display: flex; flex-direction: column; gap: 0.5rem; }
  .conflict-hint { opacity: 0.75; font-weight: 400; }
  .conflict-working { margin: 0.75rem 0 0; opacity: 0.75; }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }

  .roster-recover {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    padding: 0.15rem 0.5rem; font-size: 0.75rem; color: var(--muted); cursor: pointer;
  }
  .roster-recover:hover { color: var(--fg); }
  .recovery-code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.05rem; letter-spacing: 0.08em;
    background: var(--band); border: 1px solid var(--accent); border-radius: 6px; padding: 0.75rem; margin: 0 0 1.25rem; word-break: break-all;
  }
  .err { color: var(--alert); margin-top: 1rem; }

  .roster { max-width: 360px; margin: 8rem auto; text-align: center; }
  .roster.wide { max-width: 76rem; margin: 3rem auto; }
  .roster .sub { color: var(--muted); margin: 0 0 1.5rem; }
  .roster-list { list-style: none; padding: 0; margin: 0 0 1.5rem; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; text-align: left; }
  .roster-list li { border-bottom: 1px solid var(--border); display: flex; align-items: center; }
  .roster-list li:last-child { border-bottom: none; }
  .roster-name { flex: 1; text-align: left; padding: 0.6rem 0.9rem; background: none; border: none; font: inherit; color: var(--fg); cursor: pointer; }
  .roster-name:hover { background: var(--border); }
  .roster-remove { flex: none; margin-right: 0.5rem; padding: 0.25rem 0.6rem; font-size: 0.8rem; background: none; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); cursor: pointer; }
  .roster-remove:hover { color: var(--alert); border-color: var(--alert); }
  .roster-request { flex: none; margin-right: 0.5rem; padding: 0.25rem 0.6rem; font-size: 0.8rem; background: none; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); cursor: pointer; }
  .roster-request:hover { color: var(--accent); border-color: var(--accent); }
  .roster-name-disabled { flex: 1; text-align: left; padding: 0.6rem 0.9rem; color: var(--muted); }
  .roster-back { display: inline-block; margin-bottom: 1rem; }

  /* W44 P4 — owner Access panel (manage providers) */
  .access-panel { display: flex; flex-direction: column; gap: 1rem; min-width: 20rem; }
  .access-intro { color: var(--muted); margin: 0; font-size: 0.9rem; }
  .access-empty { color: var(--muted); margin: 0; }
  .access-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .access-list li { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.6rem 0.9rem; border-bottom: 1px solid var(--border); }
  .access-list li:last-child { border-bottom: none; }
  .access-kind { color: var(--muted); font-size: 0.8rem; margin-left: 0.4rem; }
  .access-revoke { padding: 0.3rem 0.7rem; border: 1px solid var(--alert); background: transparent; color: var(--alert); border-radius: 8px; cursor: pointer; font: inherit; font-size: 0.85rem; }
  .access-revoke:disabled { opacity: 0.5; cursor: default; }
  .access-subhead { font-weight: 600; margin: 0 0 0.4rem; font-size: 0.9rem; }
  .access-pending { border-bottom: 1px solid var(--border); padding-bottom: 0.75rem; }
  .access-approve-actions { display: flex; align-items: center; gap: 0.4rem; }
  .access-approve-actions select { padding: 0.25rem 0.4rem; border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 0.8rem; }
  .access-approve { padding: 0.3rem 0.7rem; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 8px; cursor: pointer; font: inherit; font-size: 0.85rem; }
  .access-approve:disabled { opacity: 0.5; cursor: default; }
  .access-add { display: flex; gap: 0.5rem; }
  .access-add input { flex: 1; padding: 0.5rem 0.7rem; border: 1px solid var(--border); border-radius: 6px; font: inherit; }
  .access-add-btn { padding: 0.5rem 1rem; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 8px; cursor: pointer; font: inherit; }
  .access-add-btn:disabled { opacity: 0.5; cursor: default; }
  .access-error { color: var(--alert); margin: 0; font-size: 0.9rem; }
  .account-profile { display: flex; flex-direction: column; gap: 0.6rem; }
  .account-profile label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--muted); }
  .account-profile input { padding: 0.5rem 0.7rem; border: 1px solid var(--border); border-radius: 6px; font: inherit; color: var(--fg); }
  .account-profile button { align-self: flex-start; padding: 0.5rem 1rem; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 6px; cursor: pointer; font: inherit; }
  .account-profile button:disabled { opacity: 0.5; cursor: default; }
  .account-add { display: flex; flex-direction: column; gap: 0.5rem; }
  .account-add > button { align-self: flex-start; padding: 0.5rem 1rem; border: 1px solid var(--accent); background: white; color: var(--accent); border-radius: 6px; cursor: pointer; font: inherit; }
  .account-add > button:disabled { opacity: 0.5; cursor: default; }

  .app-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 1.25rem;
    border-bottom: 1px solid var(--border);
    background: white;
    flex-wrap: wrap;
  }
  .brand { font-weight: 600; }
  .header-spacer { flex: 1; }
  .verify-banner {
    display: flex; align-items: center; gap: 0.6rem; justify-content: center; flex-wrap: wrap;
    padding: 0.45rem 1rem; font-size: 0.85rem; border-bottom: 1px solid var(--border);
  }
  .verify-banner.warn { background: var(--warn-band); color: var(--warn); }
  .verify-banner.ok { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); }
  .verify-link, .verify-x {
    border: none; background: none; font: inherit; cursor: pointer; color: inherit; text-decoration: underline;
  }
  .verify-x { text-decoration: none; opacity: 0.7; }
  .header-link {
    padding: 0.35rem 0.8rem; border: 1px solid var(--border); background: white; color: var(--muted); border-radius: 999px; font: inherit; font-size: 0.85rem; cursor: pointer;
  }
  .header-link:hover { color: var(--accent); border-color: var(--accent); }
  /* M78 Phase 14 — the contextual top-right kebab, fixed above the page content. A plain white
     pill background so the trigger stays visible over whatever content sits beneath it (it's no
     longer inside a header bar of its own). */
  .page-kebab { position: fixed; top: 0.5rem; right: 0.5rem; z-index: 31; }
  .page-kebab :global(.leaf-menu-trigger) {
    background: white; border: 1px solid var(--border); border-radius: 8px; width: 36px; height: 36px;
  }
  @media print { .page-kebab { display: none !important; } }

  /* W42 — single centered content column (header stays full-width). Everything below the
     header — tab strip, tagline, content, and (via the same --content-max token) the
     Disclaimer/Footer — shares one aligned column. */
  .page-container { max-width: var(--content-max); margin: 0 auto; flex: 1 1 auto; min-width: 0; }

  .shell-row { display: flex; align-items: flex-start; }
  .sidebar-toggle { display: none; }

  .tab-content { padding: 1.5rem 1.25rem; }
  .needs-client { color: var(--muted); }

  @media (max-width: 640px) {
    .shell-row { display: block; }
    /* M78 Phase 13 — fixed corner button now that it's no longer a header flex child. */
    .sidebar-toggle {
      display: inline-flex; align-items: center; justify-content: center;
      position: fixed; top: 0.5rem; left: 0.5rem; z-index: 31;
      width: 44px; height: 44px; border: 1px solid var(--border); border-radius: 8px;
      background: white; font-size: 1.3rem; cursor: pointer;
    }
    .tab-content { padding: 1rem 0.85rem; }
    /* M73 Phase 2 — the app's 44px touch-target convention for the remaining .header-link
       controls (roster-back, DAG toggle — refresh-status/-cancel/-err moved to the sidebar in
       M78 Phase 11). */
    .header-link { min-height: 44px; }
  }

  @media print {
    .app-header, .sidebar-toggle { display: none !important; }
    :global(body) { background: white; }
    .tab-content { padding: 0; }
    /* @page margin boxes below can't resolve custom properties in most print engines, so the
       #888 literals here stay hardcoded rather than referencing --muted. */
    :global(figure) { break-inside: avoid; page-break-inside: avoid; }
    @page {
      margin: 0.5in 0.5in 0.7in 0.5in;
      @bottom-left {
        content: "LexiTar-Generated decision support, not a diagnosis. Discuss with a physician.";
        font-size: 7pt;
        color: #888;
        font-family: system-ui, -apple-system, sans-serif;
        padding-bottom: 0.1in;
      }
      @bottom-center {
        content: var(--inference-mode, "");
        font-size: 7pt;
        color: #888;
        font-family: system-ui, -apple-system, sans-serif;
        padding-bottom: 0.1in;
      }
      @bottom-right {
        content: var(--patient-label, "") " · " counter(page);
        font-size: 7pt;
        color: #888;
        font-family: system-ui, -apple-system, sans-serif;
        padding-bottom: 0.1in;
      }
    }
  }
</style>

import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./_login";
import { syntheticTag, SYNTHETIC_WORKER_COUNT, FRESH_SEED } from "../fixtures/synthetic-patient";

// The e2e-only clinician minted alongside the synthetic patients. Mirrors E2E_PROVIDER in
// scripts/provision-e2e-patient.ts — deliberately NOT the pilots' fam4, whose password is the real
// family passphrase and whose roster is asserted exactly by cover-render.spec.ts.
export const E2E_CLINICIAN = { email: "e2e-clinician@local.invalid", password: "e2e-clinician" };

// The e2e-only support agent (provider_kind='support'), provisioned by
// scripts/provision-support-account.ts and re-seeded (RESET=1) on every scripts/e2e-serve.sh boot.
// LOCAL-only, like E2E_CLINICIAN above — it has no vault of its own and grants nobody anything until
// a spec asks for it, so it was never a "pilot" by this file's own definition even before it lived here.
export const E2E_SUPPORT = { email: "support@local.invalid", password: "support", name: "Support Agent" };

// W69 — sign in as THIS worker's own synthetic patient.
//
// The pilots (Alex, Blair) are real people with real records, and every spec that mutates them is a
// concurrent writer to the same vault — which is why `playwright.config.ts` pins `workers: 1`. A spec
// that opts in here instead gets a patient nobody else is touching, and becomes safe to parallelise.
//
// The worker index is the isolation unit. Playwright guarantees a worker runs one spec file at a time,
// so "my worker's patient" is exactly as isolated as "my file's patient" would be, at a ninth of the
// provisioning cost. scripts/e2e-serve.sh seeds `E2E_WORKERS` of them at boot.
//
// Contrast with signUpRaw(): that also yields a private account, but an EMPTY one. These carry a full
// synthetic vault (tests/fixtures/synthetic-patient.ts), so specs that assert against real content —
// sidebar grouping, search, navigation — can move onto them.
//
// Everything visible carries the worker's tag, so an assertion that fails names the worker that
// actually produced the value instead of leaving two indistinguishable patients.

/** The slug for a worker's patient — must match scripts/provision-e2e-patient.ts. */
export const syntheticSlug = (workerIndex: number): string => `e2e-w${workerIndex}`;

interface Synthetic {
  slug: string;
  name: string;
  tag: string;
  email: string;
  password: string;
}

function syntheticFor(slug: string): Synthetic {
  return { slug, name: `Synthetic ${syntheticTag(slug)}`, tag: syntheticTag(slug), email: `${slug}@local.invalid`, password: slug };
}

/** An explicit worker's patient — for a spec that needs two synthetic patients open at once, where
 * neither one can be "whichever worker happens to run this file". */
export function syntheticAt(index: number): Synthetic {
  return syntheticFor(syntheticSlug(index));
}

/**
 * A synthetic patient's URL-hash prefix — exactly like PILOTS.*.clientId in _login.ts, but NOT the
 * same kind of id: a pilot's clientId is a UUID naming a row inside the vault's `clients` map. A
 * synthetic vault has no such row-level id — syntheticVault() in tests/fixtures/synthetic-patient.ts
 * keys `clients` directly by the worker's slug — so the app's `selectedClientId` (App.svelte, chosen
 * from `Object.keys(vault.clients)`) IS the slug. Using idsFor()'s D1 account id here instead once
 * produced a well-formed but wrong id, silently misrouting every permalink test onto the
 * "different patient" (blocked) path.
 */
export const syntheticClientId = (index: number): string => syntheticSlug(index);

/** A worker index guaranteed to differ from `index` — a real but WRONG patient id for a spec that
 * needs to prove cross-patient isolation (e.g. pasting another patient's permalink). */
export const otherSyntheticIndex = (index: number): number => (index + 1) % SYNTHETIC_WORKER_COUNT;

/** This worker's patient. Reads `parallelIndex`, so it is correct at any `workers` setting. */
export function mySynthetic(): Synthetic {
  return syntheticAt(test.info().parallelIndex);
}

/** The one synthetic patient provisioned fresh — see FRESH_SEED in tests/fixtures/synthetic-patient.ts. */
export function freshSynthetic(): Synthetic {
  return syntheticFor(`e2e-${FRESH_SEED}`);
}

async function openAsPatient(page: Page, who: Synthetic): Promise<Synthetic> {
  await loginAs(page, who.email, who.password);
  await page.waitForSelector(".sidebar .nav-item");
  return who;
}

/**
 * Sign in as the e2e clinician and drill into `who` from the roster.
 *
 * Its own account, not fam4 — so this needs no secret and cannot disturb the pilots' roster.
 */
async function signInAsClinicianOnto(page: Page, who: Synthetic): Promise<Synthetic> {
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await page.click(`.roster-name:has-text("${who.name}")`);
  await page.waitForSelector(".sidebar .nav-item");
  return who;
}

/** Sign in as an explicit worker's synthetic patient — see syntheticAt(). */
export const openSyntheticAt = (page: Page, index: number): Promise<Synthetic> => openAsPatient(page, syntheticAt(index));

/** Sign in as this worker's synthetic patient and wait for the app shell. */
export const openSynthetic = (page: Page): Promise<Synthetic> => openSyntheticAt(page, test.info().parallelIndex);

/** Sign in as the e2e clinician and drill into an explicit worker's synthetic patient — see syntheticAt(). */
export const openSyntheticAsProviderAt = (page: Page, index: number): Promise<Synthetic> => signInAsClinicianOnto(page, syntheticAt(index));

export const openSyntheticAsProvider = (page: Page): Promise<Synthetic> => openSyntheticAsProviderAt(page, test.info().parallelIndex);

/** Sign in as the dedicated "fresh" synthetic patient — the one whose Finding reads as stale on every node. */
export const openFreshSynthetic = (page: Page): Promise<Synthetic> => openAsPatient(page, freshSynthetic());

export const openFreshSyntheticAsProvider = (page: Page): Promise<Synthetic> => signInAsClinicianOnto(page, freshSynthetic());

/** Every synthetic patient's roster display name — the per-worker roster plus the dedicated fresh one. */
export const ALL_SYNTHETIC_NAMES: string[] = [
  ...Array.from({ length: SYNTHETIC_WORKER_COUNT }, (_, i) => syntheticAt(i).name),
  freshSynthetic().name,
];

/**
 * Assert the page really is showing THIS worker's patient — the cross-worker-leak canary.
 *
 * Checks the TREATMENT body, not the sidebar. The sidebar renders section labels only (Search, Chat,
 * Notes, Treatment, Markers, Reports, Profile) and never the patient's name, so asserting the tag
 * there could only ever fail — which is exactly what it did on first run.
 */
export async function expectOwnPatient(page: Page, who: Synthetic): Promise<void> {
  await page.locator(".sidebar .nav-list .nav-item", { hasText: "Treatment" }).click();
  // Poll the rendered text rather than a guessed selector, and put the ACTUAL text in the failure.
  // Two earlier attempts asserted against elements that could never match (`.sidebar` never shows the
  // patient's name; there is no "Doctor" nav item), and each cost a CI round-trip to learn one fact.
  // A locator that reports what it saw turns the next wrong guess into a single run instead of two.
  const tagged = `Rosuvastatin ${who.tag}`;
  await expect
    .poll(async () => (await page.locator("body").innerText()).replace(/\s+/g, " "), {
      timeout: 15_000,
      message: `expected this worker's content (${tagged}) somewhere on the page after opening Treatment`,
    })
    .toContain(tagged);
}

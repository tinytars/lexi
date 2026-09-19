import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./_login";
import { clickNav } from "./_nav";
import { syntheticTag, SYNTHETIC_WORKER_COUNT, FRESH_SEED } from "../fixtures/synthetic-patient";

// Not the pilots' fam4, whose roster cover-render.spec.ts asserts exactly.
export const E2E_CLINICIAN = { email: "e2e-clinician@local.invalid", password: "e2e-clinician" };

// Re-seeded on every e2e-serve.sh boot; grants nobody anything until a spec asks.
export const E2E_SUPPORT = { email: "support@local.invalid", password: "support", name: "Support Agent" };

// Each Playwright worker signs in as its own synthetic patient, so a spec using these is safe to parallelise.

/** The slug for a worker's patient — must match scripts/provision-e2e-patient.ts. */
export const syntheticSlug = (workerIndex: number): string => `e2e-w${workerIndex}`;

export interface Synthetic {
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

// A synthetic vault keys `clients` by slug, so the slug (not the D1 account id) is the client id.
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

async function drillInto(page: Page, who: Synthetic): Promise<Synthetic> {
  await page.click(`.roster-name:has-text("${who.name}")`);
  await page.waitForSelector(".sidebar .nav-item");
  return who;
}

async function signInAsClinicianOnto(page: Page, who: Synthetic): Promise<Synthetic> {
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  return drillInto(page, who);
}

export async function reloadOntoPatient(page: Page, who: Synthetic = mySynthetic()): Promise<Synthetic> {
  await page.reload();
  await page.waitForSelector(".roster-list", { timeout: 15_000 });
  return drillInto(page, who);
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

// The cross-worker-leak canary: the patient's tag only renders in the Treatment body, never the sidebar.
export async function expectOwnPatient(page: Page, who: Synthetic): Promise<void> {
  await clickNav(page, "Treatment");
  const tagged = `Rosuvastatin ${who.tag}`;
  await expect
    .poll(async () => (await page.locator("body").innerText()).replace(/\s+/g, " "), {
      timeout: 15_000,
      message: `expected this worker's content (${tagged}) somewhere on the page after opening Treatment`,
    })
    .toContain(tagged);
}

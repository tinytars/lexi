import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./_login";
import { syntheticTag } from "../fixtures/synthetic-patient";

// The e2e-only clinician minted alongside the synthetic patients. Mirrors E2E_PROVIDER in
// scripts/provision-e2e-patient.ts — deliberately NOT the pilots' fam4, whose password is the real
// family passphrase and whose roster is asserted exactly by cover-render.spec.ts.
export const E2E_CLINICIAN = { email: "e2e-clinician@local.invalid", password: "e2e-clinician" };

// W69 — sign in as THIS worker's own synthetic patient.
//
// The pilots (Pablo, Liz) are real people with real records, and every spec that mutates them is a
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

/** The display name the roster shows. Derived from the SEED the provisioner passes, which is the slug. */
export const syntheticName = (workerIndex: number): string => `Synthetic ${syntheticTag(syntheticSlug(workerIndex))}`;

interface Synthetic {
  slug: string;
  name: string;
  tag: string;
  email: string;
  password: string;
}

/** This worker's patient. Reads `parallelIndex`, so it is correct at any `workers` setting. */
export function mySynthetic(): Synthetic {
  const i = test.info().parallelIndex;
  const slug = syntheticSlug(i);
  return { slug, name: syntheticName(i), tag: syntheticTag(slug), email: `${slug}@local.invalid`, password: slug };
}

/** Sign in as this worker's synthetic patient and wait for the app shell. */
export async function openSynthetic(page: Page): Promise<Synthetic> {
  const who = mySynthetic();
  await loginAs(page, who.email, who.password);
  await page.waitForSelector(".sidebar .nav-item");
  return who;
}

/**
 * Sign in as the e2e clinician and drill into this worker's synthetic patient from the roster.
 *
 * Its own account, not fam4 — so this needs no secret and cannot disturb the pilots' roster.
 */
export async function openSyntheticAsProvider(page: Page): Promise<Synthetic> {
  const who = mySynthetic();
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await page.click(`.roster-name:has-text("${who.name}")`);
  await page.waitForSelector(".sidebar .nav-item");
  return who;
}

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

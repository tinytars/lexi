import { test, expect } from "./_fixtures";
import { openSynthetic, openSyntheticAsProvider, mySynthetic, expectOwnPatient } from "./_synthetic";

// W69 — the proof that a worker-owned synthetic patient is a real, usable patient.
//
// Everything about the synthetic path is verifiable off-browser except this: that the account logs in,
// that the DEK envelope minted from public keys alone actually opens the vault in a browser, and that
// the content arrives. tests/unit/provision-e2e-patient.test.ts round-trips the crypto; this closes
// the loop through the real Functions, real D1 and real R2 self-seed.
//
// It runs alongside the pilots at `workers: 1` for now — deliberately additive. Moving existing specs
// onto synthetic patients and raising the worker count only makes sense once this is green, and only
// on a runner that is not also the developer's machine (the parallelism costs memory, and this one is
// already swapping).

test("a synthetic patient signs in and their vault decrypts", async ({ page }) => {
  const who = await openSynthetic(page);
  await expect(page.locator(".sidebar .nav-item").first()).toBeVisible();
  // The vault opened: this text exists only INSIDE the encrypted blob, so seeing it proves the
  // envelope wrapped from public keys was unwrapped by the account's password-derived private key.
  await expectOwnPatient(page, who);
});

test("the synthetic vault carries real content, not just a shell", async ({ page }) => {
  const who = await openSynthetic(page);
  await expectOwnPatient(page, who);
});

test("the clinician can drill into a synthetic patient from the roster", async ({ page }) => {
  const who = await openSyntheticAsProvider(page);
  await expect(page.locator(".sidebar .nav-item").first()).toBeVisible();
  await expectOwnPatient(page, who);
});

// The isolation claim itself. At workers: 1 this is trivially true and the test is cheap insurance;
// at workers: N it is the assertion that the whole phase rests on, and it fails loudly if two workers
// were ever handed the same patient.
test("this worker's patient is its own", async ({ page }) => {
  const who = mySynthetic();
  expect(who.slug).toBe(`e2e-w${test.info().parallelIndex}`);
  await openSynthetic(page);
  await expectOwnPatient(page, who);
  // And NOT anyone else's. Scoped to the treatment name, which every worker's fixture tags.
  const text = await page.locator("body").innerText();
  for (let other = 0; other < 4; other++) {
    if (other === test.info().parallelIndex) continue;
    expect(text).not.toContain(`Rosuvastatin E2E-W${other}`);
  }
});

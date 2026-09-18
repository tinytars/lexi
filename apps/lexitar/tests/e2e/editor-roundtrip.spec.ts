import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { loginAs } from "./_login";
import { E2E_CLINICIAN, mySynthetic } from "./_synthetic";
import { clickNav } from "./_nav";
import { interceptVaultSave, VAULT_BLOB } from "./_stubs";

// W10b: the editor save→reload→persisted round-trip that editor.spec.ts stops
// short of, plus unlock error states. DISK-SAFETY IS MANDATORY: the save POST is
// intercepted and the re-encrypted blob is replayed in-memory on reload, so
// public/data-*.enc on disk is never written.

// Synthetic patients follow {slug}@local.invalid + slug-as-password (see tests/e2e/_synthetic.ts).
async function unlock(page: Page, slug: string) {
  await loginAs(page, `${slug}@local.invalid`, slug);
}

test("Personalization save → reload → the edit persisted (no disk write)", async ({ page }) => {
  // Capture the re-encrypted blob and replay it on the reload; never write it to R2.
  const wasCaptured = interceptVaultSave(page);
  const patient = mySynthetic();

  const sentinel = "E2E roundtrip sentinel 4271";
  // W37 — the profile editor lives at Patient → Profile; drill in from the provider roster.
  const drillFromRoster = async () => {
    await page.locator(".roster-name", { hasText: patient.name }).click();
    await page.waitForSelector(".sidebar .nav-item", { timeout: 10_000 });
    await clickNav(page, "Profile");
    await page.waitForSelector(".personalization", { timeout: 10_000 });
    // M64 retired the separate Notes scalar field this test used to target; Goal exercises the
    // identical blur-persist behavior and still exists.
    return page.locator('.personalization label.field:has-text("Goal") textarea');
  };

  await page.goto("/", { waitUntil: "networkidle" });
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  let goal = await drillFromRoster();
  await goal.fill(sentinel);
  await goal.blur(); // M57 — persists on blur, no outer Save button exists anymore
  await expect.poll(wasCaptured, { timeout: 10_000 }).toBe(true);

  // W49 — reload auto-resumes the provider session straight to the roster (no re-login); drill back in.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".roster-list", { timeout: 15_000 });
  goal = await drillFromRoster();
  await expect(goal).toHaveValue(sentinel);
});

test("Unlock is disabled with an empty passphrase", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
});

// W71 — this asserted "unknown account: 404", which was the enumeration oracle seen from the UI:
// the salt lookup 404'd for an address with no account, so the browser could say which one it was
// before ever attempting a login. Both salt endpoints now return a decoy and the login itself fails
// uniformly, so an unregistered address and a wrong password produce the SAME message. That is the
// point, and it is what this now checks.
test("a bogus id fails the same way a wrong password does, revealing nothing", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await unlock(page, "bogusid");
  await expect(page.locator("p.err")).toContainText("login failed: 401");
  const unknownAccount = await page.locator("p.err").innerText();
  expect(unknownAccount).not.toContain("404");
  expect(unknownAccount.toLowerCase()).not.toContain("unknown");
});

test("a corrupt blob surfaces a decrypt error", async ({ page }) => {
  // HD1 magic + garbage → passes the magic-byte check, then decryptVault throws.
  const garbage = Buffer.concat([Buffer.from([0x48, 0x44, 0x31]), Buffer.alloc(40, 7)]);
  // Only the blob route — `**/api/vault/*` also matches the sibling routes, which the unlock path
  // reads and which must not be answered with garbage.
  await page.route(VAULT_BLOB, (route) =>
    /\/api\/vault\/(rotate|org-key|principals|recovery-envelope)$/.test(route.request().url())
      ? route.continue()
      : route.fulfill({ status: 200, contentType: "application/octet-stream", body: garbage }),
  );
  await page.goto("/", { waitUntil: "networkidle" });
  await unlock(page, mySynthetic().slug);
  await expect(page.locator("p.err")).toBeVisible();
  await expect(page.locator("p.err")).not.toBeEmpty();
});

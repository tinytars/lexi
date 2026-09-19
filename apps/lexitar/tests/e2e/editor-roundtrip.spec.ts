import { test, expect } from "./_fixtures";
import { loginAs } from "./_login";
import { mySynthetic, openSyntheticAsProvider, reloadOntoPatient } from "./_synthetic";
import { clickNav } from "./_nav";
import { interceptVaultSave, VAULT_BLOB } from "./_stubs";

// The editor save/reload round-trip, plus unlock error states. The vault PUT is captured and replayed, never written.

test("Personalization save → reload → the edit persisted (no disk write)", async ({ page }) => {
  const wasCaptured = interceptVaultSave(page);

  const sentinel = "E2E roundtrip sentinel 4271";
  const openGoal = async () => {
    await clickNav(page, "Profile");
    await page.waitForSelector(".personalization", { timeout: 10_000 });
    return page.locator('.personalization label.field:has-text("Goal") textarea');
  };

  await openSyntheticAsProvider(page);
  let goal = await openGoal();
  await goal.fill(sentinel);
  await goal.blur();
  await expect.poll(wasCaptured, { timeout: 10_000 }).toBe(true);

  await reloadOntoPatient(page);
  goal = await openGoal();
  await expect(goal).toHaveValue(sentinel);
});

test("Unlock is disabled with an empty passphrase", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
});

// An unregistered address must fail exactly like a wrong password, or the UI is an enumeration oracle.
test("a bogus id fails the same way a wrong password does, revealing nothing", async ({ page }) => {
  await loginAs(page, "bogusid@local.invalid", "bogusid");
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
  const who = mySynthetic();
  await loginAs(page, who.email, who.password);
  await expect(page.locator("p.err")).toBeVisible();
  await expect(page.locator("p.err")).not.toBeEmpty();
});
